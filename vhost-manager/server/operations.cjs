const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { fileHash, exists } = require("./core.cjs")

function run(command, args, config, input) {
  if (config.testMode) return { status: 0, stdout: "test mode: command simulated", stderr: "" }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  }
}

function ensureRoot(config) {
  if (!config.testMode && process.getuid?.() !== 0)
    throw new Error("Run the manager as root: sudo npm run vhost:start")
}

function atomicWrite(file, content, { mode, owner, group = owner, config } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const current = exists(file) ? fs.statSync(file) : null
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  let renamed = false
  try {
    fs.writeFileSync(temp, content, { mode: mode ?? current?.mode ?? 0o640, flag: "wx" })
    if (current) fs.chownSync(temp, current.uid, current.gid)
    else if (owner && !config?.testMode) chownNamed(temp, owner, group || owner, config)
    fs.renameSync(temp, file)
    renamed = true
    if (mode != null) fs.chmodSync(file, mode)
  } catch (error) {
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Preserve the original write or ownership error.
      }
    }
    throw error
  }
}

function userIds(user, group, config) {
  if (config.testMode) return { uid: process.getuid(), gid: process.getgid() }
  const uidResult = run("/usr/bin/id", ["-u", user], config)
  const gidResult = run("/usr/bin/getent", ["group", group], config)
  if (uidResult.status !== 0 || gidResult.status !== 0)
    throw new Error(`Account or group not found: ${user}:${group}`)
  const uid = Number(uidResult.stdout.trim())
  const gid = Number(gidResult.stdout.trim().split(":")[2])
  if (!Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error(`Could not resolve ownership for ${user}:${group}`)
  return { uid, gid }
}

function chownNamed(target, user, group = user, config) {
  if (config?.testMode) return
  const { uid, gid } = userIds(user, group, config || { testMode: false })
  fs.chownSync(target, uid, gid)
}

function copySnapshot(target, backupRoot) {
  const isPresent = exists(target)
  const relative = path.relative(path.parse(target).root, target)
  const backup = path.join(backupRoot, "rootfs", relative)
  if (isPresent) {
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
    if (fs.lstatSync(target).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(target), backup)
    else
      fs.cpSync(target, backup, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      })
  }
  return { target, backup, existed: isPresent }
}

function takeSnapshot(paths, config, id, { archive = false } = {}) {
  const root = archive
    ? path.join(config.backupDir, "archive", id)
    : path.join(config.backupDir, id)
  const existingSnapshot = path.join(root, "snapshot.json")
  if (archive && exists(existingSnapshot)) {
    const snapshot = JSON.parse(fs.readFileSync(existingSnapshot, "utf8"))
    if (snapshot.id !== id)
      throw new Error("The requested archive already exists with a different operation id.")
    return { root, items: snapshot.items, reused: true }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  const items = [...new Set(paths)].map((target) => copySnapshot(target, root))
  fs.writeFileSync(
    path.join(root, "snapshot.json"),
    JSON.stringify({ id, createdAt: new Date().toISOString(), items }, null, 2),
    { mode: 0o600 }
  )
  return { root, items }
}

function restoreSnapshot(snapshot) {
  for (const item of snapshot.items) {
    fs.rmSync(item.target, { recursive: true, force: true })
    if (!item.existed) continue
    fs.mkdirSync(path.dirname(item.target), { recursive: true, mode: 0o755 })
    if (fs.lstatSync(item.backup).isSymbolicLink())
      fs.symlinkSync(fs.readlinkSync(item.backup), item.target)
    else
      fs.cpSync(item.backup, item.target, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        force: true,
      })
  }
}

function verifyFingerprint(fingerprint) {
  for (const [file, expected] of Object.entries(fingerprint || {})) {
    if (fileHash(file) !== expected)
      throw new Error(`Configuration changed after preview; rescan and review again: ${file}`)
  }
}

function testServices(config) {
  const nginx = run(config.nginxBinary, ["-t"], config)
  const ols = run(config.olsBinary, ["-t"], config)
  return {
    nginx: { ok: nginx.status === 0, output: (nginx.stderr || nginx.stdout).trim().slice(0, 1200) },
    ols: { ok: ols.status === 0, output: (ols.stderr || ols.stdout).trim().slice(0, 1200) },
  }
}

function reloadService(service, config) {
  if (config.testMode) return
  const active = run("/usr/bin/systemctl", ["is-active", "--quiet", service], config)
  const action = active.status === 0 ? "reload" : "start"
  const result = run("/usr/bin/systemctl", [action, service], config)
  if (result.status !== 0)
    throw new Error(`Could not ${action} ${service}: ${(result.stderr || result.stdout).trim()}`)
}

function restoreAndReload(snapshot, config, cause, recover) {
  restoreSnapshot(snapshot)
  if (recover) recover()
  const checks = testServices(config)
  if (!checks.nginx.ok || !checks.ols.ok) {
    throw new Error(
      `${cause.message} Rollback restored files, but validation still fails. Nginx: ${checks.nginx.output}; OpenLiteSpeed: ${checks.ols.output}`
    )
  }
  try {
    reloadService("nginx", config)
    reloadService("lshttpd", config)
  } catch (error) {
    throw new Error(
      `${cause.message} Rollback restored and validated files, but service recovery failed: ${error.message}`,
      { cause: error }
    )
  }
}

function reconcileFirewall(domain, previousPorts, nextPorts, config) {
  if (config.testMode) return
  const previous = previousPorts || { tcp: [], udp: [] }
  const next = nextPorts || { tcp: [], udp: [] }
  for (const [binary, family] of [
    ["/usr/sbin/iptables", "IPv4"],
    ["/usr/sbin/ip6tables", "IPv6"],
  ]) {
    const chain = run(binary, ["-S", "VHOST-MANAGER"], config)
    if (chain.status !== 0) {
      const created = run(binary, ["-N", "VHOST-MANAGER"], config)
      if (created.status !== 0)
        throw new Error(
          `Could not create the ${family} VHOST-MANAGER chain: ${created.stderr || created.stdout}`
        )
    }
    for (const protocol of ["tcp", "udp"]) {
      const marker = `vhm_${domain.replace(/[^a-z0-9]/g, "_")}_${protocol}`
      const desired = new Set(next[protocol] || [])
      for (const port of new Set([...(previous[protocol] || []), ...(next[protocol] || [])])) {
        const args = [
          "-p",
          protocol,
          "-m",
          protocol,
          "--dport",
          String(port),
          "-m",
          "comment",
          "--comment",
          marker,
          "-j",
          "ACCEPT",
        ]
        const exists = run(binary, ["-C", "VHOST-MANAGER", ...args], config)
        if (exists.status === 0 && !desired.has(port)) {
          const removed = run(binary, ["-D", "VHOST-MANAGER", ...args], config)
          if (removed.status !== 0)
            throw new Error(`Could not remove the reviewed ${family} ${protocol}/${port} rule.`)
        }
      }
      for (const port of next[protocol] || []) {
        const args = [
          "-p",
          protocol,
          "-m",
          protocol,
          "--dport",
          String(port),
          "-m",
          "comment",
          "--comment",
          marker,
          "-j",
          "ACCEPT",
        ]
        if (run(binary, ["-C", "VHOST-MANAGER", ...args], config).status !== 0) {
          const added = run(binary, ["-A", "VHOST-MANAGER", ...args], config)
          if (added.status !== 0)
            throw new Error(
              `Could not add the reviewed ${family} ${protocol}/${port} rule: ${added.stderr || added.stdout}`
            )
        }
      }
    }
    const jumpArgs = ["-j", "VHOST-MANAGER"]
    if (run(binary, ["-C", "INPUT", ...jumpArgs], config).status !== 0) {
      const inputRules = run(binary, ["-S", "INPUT"], config).stdout
      const inputLines = inputRules.split(/\r?\n/)
      const sshWatch = inputLines.findIndex((line) => line === "-A INPUT -j SSHWATCH")
      const position =
        sshWatch >= 0
          ? inputLines.slice(0, sshWatch + 1).filter((line) => line.startsWith("-A INPUT "))
              .length + 1
          : 1
      const inserted = run(binary, ["-I", "INPUT", String(position), ...jumpArgs], config)
      if (inserted.status !== 0)
        throw new Error(`Could not attach the ${family} VHOST-MANAGER chain to INPUT.`)
    }
  }
}

function validateFirewallFiles(plan, config) {
  if (!plan.firewall?.addressFamilies?.length || config.testMode) return
  for (const file of plan.files.filter(
    (item) => item.path === config.iptablesRulesV4 || item.path === config.iptablesRulesV6
  )) {
    const restoreBinary =
      file.path === config.iptablesRulesV4
        ? "/usr/sbin/iptables-restore"
        : "/usr/sbin/ip6tables-restore"
    const result = run(restoreBinary, ["--test", file.path], config)
    if (result.status !== 0)
      throw new Error(
        `Invalid persisted firewall rules at ${file.path}: ${(result.stderr || result.stdout).trim()}`
      )
  }
}

function assertTargetsUnchanged(plan) {
  if (plan.fingerprint) verifyFingerprint(plan.fingerprint)
  if (plan.fingerprints) verifyFingerprint(plan.fingerprints)
}

function mkdirOwned(dir, mode, user, group, config) {
  fs.mkdirSync(dir, { recursive: true, mode })
  if (!config.testMode) chownNamed(dir, user, group, config)
  fs.chmodSync(dir, mode)
}

function createSiteAccount(user, home, config) {
  if (config.testMode) return { created: false }
  const existing = run("/usr/bin/getent", ["passwd", user], config)
  if (existing.status === 0 && existing.stdout.trim()) {
    const fields = existing.stdout.trim().split(":")
    if (path.resolve(fields[5]) !== path.resolve(home) || fields[6] !== "/usr/sbin/nologin") {
      throw new Error(
        `The account ${user} already exists with unexpected settings; choose a different site identity.`
      )
    }
    const groupResult = run("/usr/bin/getent", ["group", user], config)
    const groupFields = groupResult.stdout.trim().split(":")
    if (
      groupResult.status !== 0 ||
      groupFields[0] !== user ||
      groupFields[2] !== fields[3] ||
      groupFields[3].split(",").filter((member) => member && member !== user).length
    ) {
      throw new Error(
        `The account ${user} does not have an exclusive private primary group; repair its identity before provisioning.`
      )
    }
    const passwdResult = run("/usr/bin/getent", ["passwd"], config)
    const sharedPrimaryGroup = passwdResult.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => entry.split(":"))
      .some((entry) => entry[0] !== user && entry[3] === fields[3])
    if (passwdResult.status !== 0 || sharedPrimaryGroup)
      throw new Error(
        `The account ${user} shares its primary group with another Unix account; repair its identity before provisioning.`
      )
    return { created: false }
  }
  const result = run(
    "/usr/sbin/useradd",
    [
      "--system",
      "--user-group",
      "--home-dir",
      home,
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      user,
    ],
    config
  )
  if (result.status !== 0)
    throw new Error(`Could not create the site account: ${(result.stderr || result.stdout).trim()}`)
  return { created: true }
}

function databaseSql(sql, config) {
  return run(
    config.mysqlBinary || "/usr/bin/mysql",
    ["--protocol=socket", "--batch", "--skip-column-names"],
    config,
    sql
  )
}

function databaseErrorText(result, secret = "") {
  const output = (result.stderr || result.stdout).trim()
  return secret ? output.replaceAll(secret, "[redacted]") : output
}

function checkDatabaseAvailable(database, config) {
  if (!database?.enabled || config.testMode) return
  const { name, user } = database
  const result = databaseSql(
    `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${name}';\nSELECT COUNT(*) FROM mysql.user WHERE User = '${user}' AND Host = 'localhost';\n`,
    config
  )
  if (result.status !== 0)
    throw new Error(
      `Cannot check local MySQL/MariaDB availability using ${config.mysqlBinary || "/usr/bin/mysql"}: ${(result.stderr || result.stdout).trim() || "root socket authentication failed"}`
    )
  const [schemaCount, userCount] = result.stdout.trim().split(/\s+/).map(Number)
  if (schemaCount > 0) throw new Error(`Database ${name} already exists; choose another name.`)
  if (userCount > 0)
    throw new Error(`Database user ${user}@localhost already exists; choose another name.`)
  if (!Number.isFinite(schemaCount) || !Number.isFinite(userCount))
    throw new Error("Could not verify that the requested database name and user are available.")
}

function provisionDatabase(database, password, config) {
  if (!database?.enabled) return null
  if (
    !/^[a-zA-Z0-9_]{1,64}$/.test(database.name) ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(database.user)
  )
    throw new Error("The reviewed database name or user is invalid.")
  if (!/^[A-Za-z0-9_-]{40,}$/.test(password || ""))
    throw new Error(
      "The reviewed plan has no valid generated database password; prepare a new preview."
    )
  if (config.testMode)
    return {
      created: true,
      credentials: {
        database: database.name,
        username: database.user,
        host: database.host,
        password,
      },
    }

  let databaseCreated = false
  let userCreated = false
  try {
    const createSchema = databaseSql(
      `CREATE DATABASE \`${database.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`,
      config
    )
    if (createSchema.status !== 0)
      throw new Error(
        `Could not create database ${database.name}: ${(createSchema.stderr || createSchema.stdout).trim()}`
      )
    databaseCreated = true

    const createUser = databaseSql(
      `CREATE USER '${database.user}'@'localhost' IDENTIFIED BY '${password}';\n`,
      config
    )
    if (createUser.status !== 0)
      throw new Error(
        `Could not create database user ${database.user}@localhost: ${databaseErrorText(createUser, password)}`
      )
    userCreated = true

    const grant = databaseSql(
      `GRANT ALL PRIVILEGES ON \`${database.name}\`.* TO '${database.user}'@'localhost';\n`,
      config
    )
    if (grant.status !== 0)
      throw new Error(
        `Could not grant access to database ${database.name}: ${(grant.stderr || grant.stdout).trim()}`
      )
  } catch (error) {
    try {
      removeProvisionedDatabase(database, config, { databaseCreated, userCreated })
    } catch (cleanupError) {
      throw new Error(`${error.message} Cleanup also failed: ${cleanupError.message}`, {
        cause: cleanupError,
      })
    }
    throw error
  }
  return {
    created: true,
    credentials: {
      database: database.name,
      username: database.user,
      host: database.host,
      password,
    },
  }
}

function removeProvisionedDatabase(database, config, { databaseCreated, userCreated }) {
  if (config.testMode || (!databaseCreated && !userCreated)) return
  const statements = []
  if (userCreated) statements.push(`DROP USER IF EXISTS '${database.user}'@'localhost';`)
  if (databaseCreated) statements.push(`DROP DATABASE IF EXISTS \`${database.name}\`;`)
  const result = databaseSql(`${statements.join("\n")}\n`, config)
  if (result.status !== 0)
    throw new Error((result.stderr || result.stdout).trim() || "MySQL/MariaDB cleanup failed.")
}

function writeSiteFile(file, config) {
  if (file.action === "remove") {
    fs.rmSync(file.path, { force: true })
    return
  }
  if (file.action === "symlink") {
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o755 })
    fs.symlinkSync(file.target, file.path)
    return
  }
  atomicWrite(file.path, file.content, {
    mode: file.mode,
    owner: file.owner,
    group: file.group || file.owner,
    config,
  })
  if (file.owner && !config.testMode)
    chownNamed(file.path, file.owner, file.group || file.owner, config)
}

function writeManifest(config, mutate) {
  const manifestPath = path.join(config.stateDir, "manifest.json")
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(config.stateDir, 0o700)
  if (!config.testMode) chownNamed(config.stateDir, "root", "root", config)
  let manifest = { version: 1, sites: {}, operations: [] }
  try {
    manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, "utf8")) }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
  }
  mutate(manifest)
  const temp = `${manifestPath}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  fs.renameSync(temp, manifestPath)
  if (!config.testMode) chownNamed(manifestPath, "root", "root", config)
  fs.chmodSync(manifestPath, 0o600)
  return manifest
}

function readManifest(config) {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.stateDir, "manifest.json"), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return { version: 1, sites: {}, operations: [] }
    throw error
  }
}

function addOperation(config, entry) {
  return writeManifest(config, (manifest) => {
    manifest.operations = [entry, ...(manifest.operations || [])].slice(0, 100)
  })
}

function applyReset(plan, config) {
  ensureRoot(config)
  assertTargetsUnchanged(plan)
  const previousSites = readManifest(config).sites || {}
  const backup = takeSnapshot([...plan.removePaths, config.olsMain], config, plan.id, {
    archive: true,
  })
  try {
    for (const target of plan.removePaths) fs.rmSync(target, { force: true, recursive: true })
    for (const target of plan.directories) {
      try {
        fs.rmdirSync(target)
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error
      }
    }
    const updated = plan.files.find((file) => file.path === config.olsMain)
    if (updated && updated.before !== updated.after)
      atomicWrite(config.olsMain, updated.after, { config })
    const checks = testServices(config)
    if (!checks.nginx.ok || !checks.ols.ok)
      throw new Error(
        `Reset validation failed. Nginx: ${checks.nginx.output || "pass"}; OpenLiteSpeed: ${checks.ols.output || "pass"}`
      )
    reloadService("nginx", config)
    reloadService("lshttpd", config)
    const operation = {
      id: plan.id,
      kind: "reset",
      title: plan.title,
      at: new Date().toISOString(),
      backup: backup.root,
      files: plan.files.map((file) => file.path),
      previousSites,
      rollbackAvailable: true,
      state: "applied",
    }
    addOperation(config, operation)
    writeManifest(config, (manifest) => {
      manifest.sites = Object.fromEntries(
        Object.entries(manifest.sites || {}).filter(([key]) => key.toLowerCase() === "phpmyadmin")
      )
    })
    return { operation, checks }
  } catch (error) {
    restoreAndReload(backup, config, error)
    addOperation(config, {
      id: plan.id,
      kind: "reset",
      title: plan.title,
      at: new Date().toISOString(),
      backup: backup.root,
      files: plan.files.map((file) => file.path),
      rollbackAvailable: false,
      state: "failed",
      error: error.message,
    })
    throw error
  }
}

function archiveExamples(plan, config) {
  ensureRoot(config)
  if (plan.kind !== "reset")
    throw new Error("Only a reviewed clean-initialization plan can archive examples.")
  assertTargetsUnchanged(plan)
  const paths = [...plan.removePaths, config.olsMain]
  const snapshot = takeSnapshot(paths, config, plan.id, { archive: true })
  const operation = {
    id: `archive-${plan.id}`,
    kind: "archive",
    title: "Archive discovered vhost examples",
    at: new Date().toISOString(),
    backup: snapshot.root,
    files: paths,
    rollbackAvailable: false,
    state: "archived",
  }
  addOperation(config, operation)
  return {
    operation,
    archivePath: snapshot.root,
    filesArchived: snapshot.items.filter((item) => item.existed).length,
  }
}

function applySite(plan, config) {
  ensureRoot(config)
  assertTargetsUnchanged(plan)
  checkDatabaseAvailable(plan.database, config)
  const { domain, webroot, account, group, directoryMode, requestMode } = plan.settings
  const home = path.join(config.homeRoot, domain)
  const privateDir = path.join(home, ".site-config")
  const isUpdate = Boolean(plan.settings.update)
  const previousSite = readManifest(config).sites?.[domain] || null
  const firewallPrevious = previousSite?.settings?.firewallPorts || { tcp: [], udp: [] }
  const snapshot = takeSnapshot(
    plan.files.map((file) => file.path),
    config,
    plan.id
  )
  const accountResult = createSiteAccount(account, home, config)
  const changedPaths = []
  let databaseResult = null
  try {
    if (!isUpdate) {
      mkdirOwned(home, 0o711, "root", "root", config)
    }
    mkdirOwned(webroot, directoryMode || 0o755, account, group || account, config)
    if (requestMode === "ols") {
      mkdirOwned(privateDir, 0o700, account, group || account, config)
      mkdirOwned(path.join(config.olsVhosts, domain), 0o750, "lsadm", "nogroup", config)
      if (plan.directories?.some((directory) => directory.path === config.olsLogDir))
        mkdirOwned(config.olsLogDir, 0o750, "root", "nogroup", config)
    }
    for (const file of plan.files) {
      if (file.path === config.olsMain) {
        atomicWrite(config.olsMain, file.content, { config })
        changedPaths.push(file.path)
      } else if (file.action !== "preserve") {
        writeSiteFile(file, config)
        changedPaths.push(file.path)
      }
    }
    const checks = testServices(config)
    if (!checks.nginx.ok || !checks.ols.ok)
      throw new Error(
        `Site validation failed. Nginx: ${checks.nginx.output || "pass"}; OpenLiteSpeed: ${checks.ols.output || "pass"}`
      )
    validateFirewallFiles(plan, config)
    if (plan.firewall?.addressFamilies?.length)
      reconcileFirewall(domain, firewallPrevious, plan.firewall.ports, config)
    reloadService("nginx", config)
    reloadService("lshttpd", config)
    databaseResult = provisionDatabase(plan.database, plan.databasePassword, config)
    const manifestEntry = {
      domain,
      aliases: plan.settings.aliases,
      webroot,
      account,
      template: {
        nginx: "nginx-production.conf.tpl + nginx-ssl-renewal.conf.tpl",
        ols: "ols-main-vhost.conf.tpl + ols-vhost.conf.tpl",
        php: "php.ini.tpl",
        revision: 2,
      },
      settings: {
        ...plan.settings,
        cspMode: plan.settings.cspMode,
        cspPolicy: plan.settings.cspPolicy,
        hsts: plan.settings.hsts,
        frameOptions: plan.settings.frameOptions,
        referrerPolicy: plan.settings.referrerPolicy,
        permissionsPolicy: plan.settings.permissionsPolicy,
        mimeOverrides: plan.settings.mimeOverrides,
        staticCache: plan.settings.staticCache,
        proxyCache: plan.settings.proxyCache,
      },
      hashes: Object.fromEntries(
        Object.entries({
          ...(previousSite?.hashes || {}),
          ...Object.fromEntries(
            changedPaths
              .filter((file) => file !== config.olsMain)
              .filter((file) => file !== config.iptablesRulesV4 && file !== config.iptablesRulesV6)
              .map((file) => [file, fileHash(file)])
          ),
        })
      ),
      updatedAt: new Date().toISOString(),
    }
    const operation = {
      id: plan.id,
      kind: "site",
      title: plan.title,
      domain,
      at: new Date().toISOString(),
      backup: snapshot.root,
      files: changedPaths,
      siteCreated: !isUpdate,
      previousSite,
      accountCreated: accountResult.created,
      account,
      database: plan.database?.enabled
        ? { name: plan.database.name, user: plan.database.user, host: plan.database.host }
        : null,
      firewallPrevious,
      firewallCurrent: plan.firewall?.ports || { tcp: [], udp: [] },
      rollbackAvailable: true,
      state: "applied",
    }
    writeManifest(config, (manifest) => {
      manifest.sites[domain] = manifestEntry
      manifest.operations = [operation, ...(manifest.operations || [])].slice(0, 100)
    })
    return {
      operation,
      checks,
      ...(databaseResult ? { databaseCredentials: databaseResult.credentials } : {}),
    }
  } catch (error) {
    if (databaseResult?.created) {
      try {
        removeProvisionedDatabase(plan.database, config, {
          databaseCreated: true,
          userCreated: true,
        })
      } catch (cleanupError) {
        error.message = `${error.message} Database cleanup also failed: ${cleanupError.message}`
      }
    }
    restoreAndReload(
      snapshot,
      config,
      error,
      plan.firewall?.addressFamilies?.length
        ? () =>
            reconcileFirewall(
              domain,
              plan.firewall.ports,
              previousSite?.settings?.firewallPorts || { tcp: [], udp: [] },
              config
            )
        : undefined
    )
    if (!isUpdate) {
      const cleanupDirectories = [path.join(config.olsVhosts, domain), privateDir, webroot, home]
      if (plan.directories?.some((directory) => directory.path === config.olsLogDir))
        cleanupDirectories.unshift(config.olsLogDir)
      for (const dir of cleanupDirectories) {
        try {
          fs.rmdirSync(dir)
        } catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
        }
      }
    }
    if (accountResult.created && !config.testMode) run("/usr/sbin/userdel", [account], config)
    addOperation(config, {
      id: plan.id,
      kind: "site",
      title: plan.title,
      domain,
      at: new Date().toISOString(),
      backup: snapshot.root,
      files: changedPaths,
      rollbackAvailable: false,
      state: "failed",
      error: error.message,
    })
    throw error
  }
}

function applyToggle(plan, config) {
  ensureRoot(config)
  assertTargetsUnchanged(plan)
  const backup = takeSnapshot([plan.link], config, plan.id)
  try {
    if (plan.action === "enable") {
      fs.mkdirSync(path.dirname(plan.link), { recursive: true, mode: 0o755 })
      fs.symlinkSync(plan.target, plan.link)
    } else fs.unlinkSync(plan.link)
    const nginx = run(config.nginxBinary, ["-t"], config)
    if (nginx.status !== 0)
      throw new Error(`Nginx validation failed: ${(nginx.stderr || nginx.stdout).trim()}`)
    reloadService("nginx", config)
    const operation = {
      id: plan.id,
      kind: "toggle",
      domain: plan.domain,
      title: plan.title,
      at: new Date().toISOString(),
      backup: backup.root,
      files: [plan.link],
      rollbackAvailable: true,
      state: "applied",
    }
    addOperation(config, operation)
    return {
      operation,
      checks: { nginx: { ok: true, output: (nginx.stderr || nginx.stdout).trim() } },
    }
  } catch (error) {
    restoreSnapshot(backup)
    const nginx = run(config.nginxBinary, ["-t"], config)
    if (nginx.status === 0) reloadService("nginx", config)
    addOperation(config, {
      id: plan.id,
      kind: "toggle",
      domain: plan.domain,
      title: plan.title,
      at: new Date().toISOString(),
      backup: backup.root,
      files: [plan.link],
      rollbackAvailable: false,
      state: "failed",
      error: error.message,
    })
    throw error
  }
}

function applyAdopt(plan, config) {
  ensureRoot(config)
  for (const [target, expected] of Object.entries(plan.fingerprints || {})) {
    if (fileHash(target) !== expected)
      throw new Error(`Configuration changed after preview: ${target}`)
  }
  const entry = {
    domain: plan.domain,
    aliases: plan.aliases,
    webroot: plan.webroot,
    hashes: plan.hashes,
    settings: {},
    adoptedReadOnly: true,
    updatedAt: new Date().toISOString(),
  }
  const operation = {
    id: plan.id,
    kind: "adopt",
    domain: plan.domain,
    title: plan.title,
    at: new Date().toISOString(),
    files: Object.keys(plan.hashes),
    previousSite: plan.previousSite || null,
    rollbackAvailable: true,
    state: "applied",
  }
  writeManifest(config, (manifest) => {
    manifest.sites[plan.domain] = entry
    manifest.operations = [operation, ...(manifest.operations || [])].slice(0, 100)
  })
  return { operation, checks: { filesChanged: { ok: true, output: "No server files changed." } } }
}

function applyPlan(plan, config) {
  if (plan.kind === "reset") return applyReset(plan, config)
  if (plan.kind === "site") return applySite(plan, config)
  if (plan.kind === "toggle") return applyToggle(plan, config)
  if (plan.kind === "adopt") return applyAdopt(plan, config)
  throw new Error("Unknown plan type.")
}

function history(config) {
  return readManifest(config).operations || []
}

function rollbackOperation(operationId, config) {
  ensureRoot(config)
  const operation = history(config).find((entry) => entry.id === operationId)
  if (!operation || !operation.rollbackAvailable)
    throw new Error("No reversible operation with that id was found.")
  if (operation.kind === "adopt") {
    writeManifest(config, (manifest) => {
      if (operation.previousSite) manifest.sites[operation.domain] = operation.previousSite
      else delete manifest.sites[operation.domain]
      manifest.operations = [
        {
          id: crypto.randomUUID(),
          kind: "rollback",
          title: `Undo ${operation.title}`,
          at: new Date().toISOString(),
          rollbackAvailable: false,
          state: "complete",
        },
        ...(manifest.operations || []),
      ].slice(0, 100)
      manifest.operations = manifest.operations.map((entry) =>
        entry.id === operationId
          ? { ...entry, rollbackAvailable: false, state: "rolled-back" }
          : entry
      )
    })
    return {
      operation,
      checks: {
        filesChanged: {
          ok: true,
          output: "Manager metadata restored; server files were not touched.",
        },
      },
    }
  }
  if (!operation.backup) throw new Error("The operation has no backup snapshot.")
  const snapshotFile = path.join(operation.backup, "snapshot.json")
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"))
  if (operation.kind === "reset") restoreSnapshot(snapshot)
  else {
    for (const target of operation.files.filter((file) => file !== config.olsMain))
      fs.rmSync(target, { force: true, recursive: true })
    restoreSnapshot(snapshot)
    if (operation.siteCreated) {
      const home = path.join(config.homeRoot, operation.domain)
      for (const dir of [
        path.join(config.olsVhosts, operation.domain),
        path.join(home, ".site-config"),
        path.join(home, "public_html"),
        home,
      ]) {
        try {
          fs.rmdirSync(dir)
        } catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
        }
      }
    }
    if (operation.kind === "site" && operation.firewallCurrent)
      reconcileFirewall(
        operation.domain,
        operation.firewallCurrent,
        operation.firewallPrevious || { tcp: [], udp: [] },
        config
      )
    if (operation.accountCreated && operation.account && !config.testMode)
      run("/usr/sbin/userdel", [operation.account], config)
  }
  const checks = testServices(config)
  if (!checks.nginx.ok || !checks.ols.ok)
    throw new Error(
      `Rollback restored files, but validation failed. Nginx: ${checks.nginx.output}; OpenLiteSpeed: ${checks.ols.output}`
    )
  reloadService("nginx", config)
  reloadService("lshttpd", config)
  writeManifest(config, (manifest) => {
    if (operation.kind === "reset") manifest.sites = operation.previousSites || {}
    if (operation.kind === "site") {
      if (operation.siteCreated) delete manifest.sites[operation.domain]
      else manifest.sites[operation.domain] = operation.previousSite
    }
    manifest.operations = [
      {
        id: crypto.randomUUID(),
        kind: "rollback",
        title: `Rollback ${operation.title}`,
        at: new Date().toISOString(),
        rollbackAvailable: false,
        state: "complete",
      },
      ...(manifest.operations || []),
    ].slice(0, 100)
    manifest.operations = manifest.operations.map((entry) =>
      entry.id === operationId
        ? { ...entry, rollbackAvailable: false, state: "rolled-back" }
        : entry
    )
  })
  return { operation, checks }
}

function serviceState(config) {
  const checks = testServices(config)
  const active = (service) => {
    if (config.testMode) return true
    return run("/usr/bin/systemctl", ["is-active", "--quiet", service], config).status === 0
  }
  return {
    nginx: { active: active("nginx"), configValid: checks.nginx.ok, detail: checks.nginx.output },
    ols: { active: active("lshttpd"), configValid: checks.ols.ok, detail: checks.ols.output },
    phpmyadminPreserved: exists(path.join(config.olsVhosts, "phpmyadmin")),
  }
}

module.exports = {
  run,
  ensureRoot,
  testServices,
  applyPlan,
  archiveExamples,
  history,
  rollbackOperation,
  readManifest,
  serviceState,
  takeSnapshot,
  restoreSnapshot,
}
