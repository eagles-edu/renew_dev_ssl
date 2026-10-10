const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const DEFAULT_CSP_POLICY = fs
  .readFileSync(path.join(__dirname, "../shared/csp-policy.txt"), "utf8")
  .trim()
const PHP_SIMPLE_SETTINGS = Object.freeze({
  phpMemoryLimit: { directive: "memory_limit", pattern: /^(?:-1|\d+[KMG]?)$/i },
  phpUploadMaxFilesize: { directive: "upload_max_filesize", pattern: /^\d+[KMG]?$/i },
  phpPostMaxSize: { directive: "post_max_size", pattern: /^\d+[KMG]?$/i },
  phpMaxExecutionTime: { directive: "max_execution_time", pattern: /^\d+$/ },
  phpMaxInputTime: { directive: "max_input_time", pattern: /^(?:-1|\d+)$/ },
  phpMaxInputVars: { directive: "max_input_vars", pattern: /^\d+$/ },
  phpDateTimezone: { directive: "date.timezone", pattern: /^[A-Za-z0-9_+/-]*$/ },
  phpDisplayErrors: { directive: "display_errors", pattern: /^(?:0|1)$/ },
  phpLogErrors: { directive: "log_errors", pattern: /^(?:0|1)$/ },
})

const DEFAULTS = Object.freeze({
  nginxAvailable: "/etc/nginx/sites-available",
  nginxEnabled: "/etc/nginx/sites-enabled",
  boilerplateDir: path.join(__dirname, "../boilerplate"),
  nginxMain: "/etc/nginx/nginx.conf",
  nginxConfD: "/etc/nginx/conf.d",
  mimeTypesFile: "/etc/nginx/mime.types",
  olsRoot: "/usr/local/lsws",
  olsMain: "/usr/local/lsws/conf/httpd_config.conf",
  olsVhosts: "/usr/local/lsws/conf/vhosts",
  phpIni: "/usr/local/lsws/lsphp83/etc/php/8.3/litespeed/php.ini",
  phpIniScanDir: "/usr/local/lsws/lsphp83/etc/php/8.3/mods-available",
  phpBinary: "/usr/local/lsws/lsphp83/bin/lsphp",
  olsLogDir: "/var/log/openlitespeed",
  acmeHome: "/root/.acme.sh",
  stateDir: "/var/lib/renew-dev-ssl-vhost-manager",
  backupDir: "/var/backups/renew-dev-ssl-vhost-manager",
  iptablesRulesV4: "/etc/iptables/rules.v4",
  iptablesRulesV6: "/etc/iptables/rules.v6",
  nginxLogDir: "/var/log/nginx",
  geoipLookup: "/usr/bin/geoiplookup",
  geoipDatabase: "/usr/share/GeoIP/GeoIP.dat",
  geoipDatabaseV6: "/usr/share/GeoIP/GeoIPv6.dat",
  crowdsecCli: "/usr/bin/cscli",
  crowdsecService: "crowdsec",
  crowdsecBouncerService: "crowdsec-firewall-bouncer",
  mysqlBinary: "/usr/bin/mysql",
  homeRoot: "/home",
  nginxBinary: "/usr/sbin/nginx",
  olsBinary: "/usr/local/lsws/bin/openlitespeed",
})

function configFromEnv(env = process.env) {
  if (env.VHOST_MANAGER_TEST_MODE === "1") {
    const root = path.resolve(
      env.VHOST_MANAGER_FIXTURE_ROOT || path.join(process.cwd(), "tests/fixtures/vhost-manager")
    )
    return {
      nginxAvailable: path.join(root, "etc/nginx/sites-available"),
      nginxEnabled: path.join(root, "etc/nginx/sites-enabled"),
      boilerplateDir: path.join(__dirname, "../boilerplate"),
      nginxMain: path.join(root, "etc/nginx/nginx.conf"),
      nginxConfD: path.join(root, "etc/nginx/conf.d"),
      mimeTypesFile: path.join(root, "etc/nginx/mime.types"),
      olsRoot: path.join(root, "usr/local/lsws"),
      olsLogDir: path.join(root, "var/log/openlitespeed"),
      olsMain: path.join(root, "usr/local/lsws/conf/httpd_config.conf"),
      olsVhosts: path.join(root, "usr/local/lsws/conf/vhosts"),
      phpIni: path.join(root, "usr/local/lsws/lsphp83/etc/php.ini"),
      phpIniScanDir: path.join(root, "usr/local/lsws/lsphp83/etc/conf.d"),
      phpBinary: path.join(root, "usr/local/lsws/lsphp83/bin/lsphp"),
      acmeHome: path.join(root, "root/.acme.sh"),
      stateDir: path.join(root, "var/lib/vhost-manager"),
      backupDir: path.join(root, "var/backups/vhost-manager"),
      iptablesRulesV4: path.join(root, "etc/iptables/rules.v4"),
      iptablesRulesV6: path.join(root, "etc/iptables/rules.v6"),
      nginxLogDir: path.join(root, "var/log/nginx"),
      geoipLookup: "/usr/bin/geoiplookup",
      geoipDatabase: path.join(root, "usr/share/GeoIP/GeoIP.dat"),
      geoipDatabaseV6: path.join(root, "usr/share/GeoIP/GeoIPv6.dat"),
      crowdsecCli: "/usr/bin/cscli",
      crowdsecService: "crowdsec",
      crowdsecBouncerService: "crowdsec-firewall-bouncer",
      mysqlBinary: env.VHOST_MANAGER_MYSQL_BINARY || DEFAULTS.mysqlBinary,
      homeRoot: path.join(root, "home"),
      nginxBinary: "/bin/true",
      olsBinary: "/bin/true",
      testMode: true,
    }
  }
  return {
    ...DEFAULTS,
    mysqlBinary: env.VHOST_MANAGER_MYSQL_BINARY || DEFAULTS.mysqlBinary,
    testMode: false,
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return null
    throw error
  }
}

function certificateStatus(config, domain, settings = {}) {
  const certPath = String(
    settings.certificatePath || `${config.acmeHome}/${domain}_ecc/fullchain.cer`
  )
  if (
    !certPath.startsWith(`${config.acmeHome}/`) ||
    !path.resolve(certPath).startsWith(`${path.resolve(config.acmeHome)}${path.sep}`)
  )
    return { ready: false, expiresAt: null }
  try {
    const certificate = new crypto.X509Certificate(fs.readFileSync(certPath))
    const expiresAt = Date.parse(certificate.validTo)
    const validFrom = Date.parse(certificate.validFrom)
    const now = Date.now()
    return {
      ready: Boolean(certificate.checkHost(domain)) && validFrom <= now && expiresAt > now,
      expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    }
  } catch {
    return { ready: false, expiresAt: null }
  }
}

function readPhpIniValues(source = "") {
  const directives = new Map()
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(";") || trimmed.startsWith("#") || trimmed.startsWith("[")) continue
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/)
    if (match) directives.set(match[1].toLowerCase(), match[2].replace(/^(["'])(.*)\1$/, "$2"))
  }
  return Object.fromEntries(
    Object.entries(PHP_SIMPLE_SETTINGS)
      .filter(([, setting]) => directives.has(setting.directive))
      .map(([field, setting]) => [field, directives.get(setting.directive)])
  )
}

function validatePhpIniOverrides(raw = "") {
  const text = String(raw)
  if (text.length > 20000)
    throw new Error("Advanced PHP ini overrides are limited to 20,000 characters.")
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || /^[;#]/.test(trimmed)) continue
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]*\s*=\s*[^;\r\n]+$/.test(trimmed) ||
      trimmed.includes("[") ||
      trimmed.includes("]")
    )
      throw new Error(`Invalid advanced PHP ini override: ${line}`)
  }
  return lines.filter((line) => line.trim()).join("\n")
}

function buildPhpIniOverrides(input) {
  const lines = []
  const settings = {}
  for (const [field, setting] of Object.entries(PHP_SIMPLE_SETTINGS)) {
    const value = String(input[field] ?? "").trim()
    if (!value) continue
    if (!setting.pattern.test(value))
      throw new Error(`Invalid value for PHP setting ${setting.directive}.`)
    lines.push(`${setting.directive} = ${value}`)
    settings[field] = value
  }
  const advanced = validatePhpIniOverrides(input.phpIniOverrides)
  if (advanced) lines.push(advanced)
  return { content: lines.join("\n"), settings, advanced }
}

function exists(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

function listTree(base, relative = "") {
  const current = path.join(base, relative)
  let names
  try {
    names = fs.readdirSync(current).sort()
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return []
    throw error
  }
  const found = []
  for (const name of names) {
    const rel = path.join(relative, name)
    const full = path.join(base, rel)
    const stat = fs.lstatSync(full)
    found.push({
      path: full,
      relative: rel,
      type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
    })
    if (stat.isDirectory() && !stat.isSymbolicLink()) found.push(...listTree(base, rel))
  }
  return found
}

function fileHash(file) {
  try {
    const stat = fs.lstatSync(file)
    let value
    if (stat.isSymbolicLink()) value = `link:${fs.readlinkSync(file)}`
    else if (stat.isDirectory())
      value = listTree(file)
        .map((entry) => `${entry.relative}:${fileHash(entry.path)}`)
        .join("\n")
    else value = fs.readFileSync(file)
    return crypto.createHash("sha256").update(value).digest("hex")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function validDomain(raw) {
  const domain = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
  if (domain.length > 253 || !domain.includes(".") || domain.startsWith("*.")) return null
  const labels = domain.split(".")
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  return domain
}

function parseFirewallPorts(value, protocol) {
  const tokens = Array.isArray(value)
    ? value.map(String)
    : String(value || "")
        .split(/[\s,]+/)
        .filter(Boolean)
  const ports = tokens.map((token) => {
    if (!/^\d{1,5}$/.test(token) || Number(token) < 1 || Number(token) > 65535)
      throw new Error(
        `${protocol.toUpperCase()} inbound ports must be comma-separated numbers from 1 to 65535.`
      )
    return Number(token)
  })
  const unique = [...new Set(ports)]
  if (unique.length > 30)
    throw new Error(`Enter no more than 30 ${protocol.toUpperCase()} ports per site.`)
  return unique.sort((a, b) => a - b)
}

function updatePersistentFirewall(source, domain, nextPorts, protocol) {
  const marker = `vhm_${domain.replace(/[^a-z0-9]/g, "_")}_${protocol}`
  let lines = String(source || "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.includes(`--comment ${marker}`) &&
        line !== "-A VHOST-MANAGER -m comment --comment vhm-chain -j RETURN"
    )
  const filterStart = lines.indexOf("*filter")
  if (filterStart < 0) throw new Error("iptables-persistent rules file has no *filter table.")
  let tableEnd = lines.indexOf("COMMIT", filterStart)
  if (tableEnd < 0) throw new Error("iptables-persistent rules file has no filter-table COMMIT.")
  let declarationsEnd = filterStart + 1
  while (declarationsEnd < tableEnd && lines[declarationsEnd].startsWith(":")) declarationsEnd += 1
  if (
    !lines
      .slice(filterStart + 1, declarationsEnd)
      .some((line) => line.startsWith(":VHOST-MANAGER "))
  ) {
    lines.splice(declarationsEnd++, 0, ":VHOST-MANAGER - [0:0]")
    tableEnd += 1
  }
  const inputRules = lines
    .slice(declarationsEnd, tableEnd + 1)
    .map((line, offset) => ({ line, index: declarationsEnd + offset }))
    .filter(({ line }) => line.startsWith("-A INPUT "))
  if (!inputRules.some(({ line }) => line === "-A INPUT -j VHOST-MANAGER")) {
    const sshWatch = inputRules.find(({ line }) => line === "-A INPUT -j SSHWATCH")
    const insertAt = sshWatch ? sshWatch.index + 1 : (inputRules[0]?.index ?? declarationsEnd)
    lines.splice(insertAt, 0, "-A INPUT -j VHOST-MANAGER")
  }
  let commit = lines.indexOf("COMMIT", filterStart)
  const rules = nextPorts.map(
    (port) =>
      `-A VHOST-MANAGER -p ${protocol} -m ${protocol} --dport ${port} -m comment --comment ${marker} -j ACCEPT`
  )
  lines.splice(commit, 0, ...rules, "-A VHOST-MANAGER -m comment --comment vhm-chain -j RETURN")
  return lines.join("\n").replace(/\n*$/, "\n")
}

function accountForDomain(domain, createdAt = new Date()) {
  const normalized = String(domain).toLowerCase()
  const prefix = normalized.replace(/[^a-z]/g, "").slice(0, 4)
  const domainSlug = normalized
    .split(".")
    .slice(1)
    .join("_")
    .replace(/[^a-z0-9_]/g, "")
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const monthYear = `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getFullYear()).slice(-2)}`
  const account = `${prefix}${domainSlug}${monthYear}`
  if (account.length > 32)
    throw new Error("This domain produces a Unix account longer than Ubuntu's 32-character limit.")
  return account
}

function parseServerNames(text = "") {
  const names = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const match = line.match(/^\s*server_name\s+([^;]+);/)
    if (match)
      names.push(
        ...match[1]
          .trim()
          .split(/\s+/)
          .filter((name) => name !== "_" && !name.startsWith("~"))
      )
  }
  return [...new Set(names)]
}

function parseOlsDomain(text = "") {
  const domain = text.match(/^\s*vhDomain\s+([^\s#]+)/m)?.[1]
  const aliases =
    text
      .match(/^\s*vhAliases\s+([^\n#]+)/m)?.[1]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) || []
  return { domain, aliases }
}

function parseOlsBlocks(text = "", kind = "virtualhost") {
  const lines = text.split(/(?<=\n)/)
  const blocks = []
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const header = line.match(new RegExp(`^\\s*${kind}\\s+([A-Za-z0-9_.-]+)\\s*\\{`))
    if (!header) {
      offset += line.length
      continue
    }
    const start = offset
    let depth = 0
    let end = offset
    let started = false
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const raw = lines[cursor]
      const clean = raw.replace(/#.*$/, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "")
      for (const char of clean) {
        if (char === "{") {
          depth += 1
          started = true
        } else if (char === "}") depth -= 1
      }
      end += raw.length
      if (started && depth === 0) {
        blocks.push({ name: header[1], start, end, text: text.slice(start, end) })
        index = cursor
        offset = end
        break
      }
      if (cursor === lines.length - 1) offset = end
    }
  }
  return blocks
}

function scanNginx(config) {
  const available = listTree(config.nginxAvailable)
  const enabled = listTree(config.nginxEnabled)
  const enabledByTarget = new Map()
  const links = []
  for (const item of enabled) {
    if (item.type !== "symlink") continue
    let target
    let existsTarget = false
    try {
      target = fs.readlinkSync(item.path)
      existsTarget = fs.existsSync(path.resolve(path.dirname(item.path), target))
    } catch (error) {
      if (!["ENOENT", "EINVAL"].includes(error.code)) throw error
    }
    const resolved = target ? path.resolve(path.dirname(item.path), target) : null
    if (resolved && existsTarget) {
      if (!enabledByTarget.has(resolved)) enabledByTarget.set(resolved, [])
      enabledByTarget.get(resolved).push(item.path)
    }
    links.push({ path: item.path, target, broken: !existsTarget })
  }

  const files = available.filter((item) => item.type === "file" && /\.conf$/i.test(item.path))
  const sites = files.map((item) => {
    const names = parseServerNames(readText(item.path) || "")
    return {
      path: item.path,
      names,
      enabledAt: enabledByTarget.get(path.resolve(item.path)) || [],
      hash: fileHash(item.path),
    }
  })
  const byDomain = new Map()
  for (const site of sites) {
    const [domain, ...aliases] = site.names
    if (domain) {
      if (!byDomain.has(domain))
        byDomain.set(domain, {
          id: domain,
          domain,
          aliases: [],
          nginxConfigs: [],
          olsVhosts: [],
          enabled: false,
          status: "discovered",
        })
      const entry = byDomain.get(domain)
      entry.nginxConfigs.push(site.path)
      entry.enabled ||= site.enabledAt.length > 0
      entry.aliases = [...new Set([...entry.aliases, ...aliases])]
    }
  }
  return { sites, links, available, enabled, byDomain }
}

function scanOls(config, byDomain = new Map()) {
  const source = readText(config.olsMain) || ""
  const blocks = parseOlsBlocks(source, "virtualhost")
  const vhosts = blocks.map((block) => {
    const configFile = block.text.match(/^\s*configFile\s+([^\s#]+)/m)?.[1] || null
    const configPath = configFile ? path.resolve(config.olsRoot, configFile) : null
    const text = configPath ? readText(configPath) : null
    const names = parseOlsDomain(text || "")
    const identity =
      names.domain ||
      (block.name.toLowerCase() === "phpmyadmin"
        ? "phpmyadmin"
        : block.name.toLowerCase() === "example"
          ? "example"
          : null)
    const record = {
      name: block.name,
      path: configPath,
      configFile,
      domain: identity,
      aliases: names.aliases,
      docRoot: text?.match(/^\s*docRoot\s+([^\s#]+)/m)?.[1] || null,
      exists: Boolean(text),
      hash: configPath ? fileHash(configPath) : null,
    }
    if (identity) {
      if (!byDomain.has(identity))
        byDomain.set(identity, {
          id: identity,
          domain: identity,
          aliases: [],
          nginxConfigs: [],
          olsVhosts: [],
          enabled: false,
          status: "discovered",
        })
      const site = byDomain.get(identity)
      site.olsVhosts.push(record)
      site.aliases = [...new Set([...site.aliases, ...names.aliases])]
    }
    return record
  })
  return { vhosts, listeners: parseOlsBlocks(source, "listener"), source }
}

function inventory(config, manifest = {}) {
  const nginx = scanNginx(config)
  const ols = scanOls(config, nginx.byDomain)
  const sites = [...nginx.byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain))
  for (const site of sites) {
    site.managed = Boolean(manifest.sites?.[site.id])
    site.adoptedReadOnly = Boolean(manifest.sites?.[site.id]?.adoptedReadOnly)
    site.managerSettings = manifest.sites?.[site.id]?.settings || null
    site.tls = certificateStatus(config, site.domain, site.managerSettings || {})
    site.tlsReady = site.tls.ready
    site.webroot =
      manifest.sites?.[site.id]?.webroot ||
      site.olsVhosts.map((vhost) => vhost.docRoot).find(Boolean) ||
      null
    const brokenLink = nginx.links.find(
      (link) => link.broken && path.basename(link.path).includes(site.domain)
    )
    site.invalidReasons = [
      ...(site.olsVhosts.some((entry) => !entry.exists)
        ? ["OpenLiteSpeed vhost config is missing"]
        : []),
      ...(brokenLink ? [`Nginx link points to a missing file: ${brokenLink.path}`] : []),
    ]
    site.status = site.invalidReasons.length ? "invalid" : site.enabled ? "enabled" : "disabled"
    if (!site.nginxConfigs.length && !site.olsVhosts.length) site.status = "discovered"
    if (site.managed) {
      const recorded = manifest.sites[site.id].hashes || {}
      const current = Object.fromEntries(
        Object.keys(recorded).map((file) => [file, fileHash(file)])
      )
      site.drifted = Object.entries(recorded).some(([file, hash]) => current[file] !== hash)
    } else site.drifted = false
  }
  return {
    sites,
    nginx: { links: nginx.links, configs: nginx.sites },
    ols: { vhosts: ols.vhosts, listeners: ols.listeners.map((x) => x.name) },
  }
}

function stripBlock(text, block) {
  return text.slice(0, block.start) + text.slice(block.end)
}

function resetOlsConfig(source) {
  let updated = source
  const keep = new Set(["phpmyadmin"])
  for (const block of [...parseOlsBlocks(updated, "virtualhost")].reverse()) {
    if (!keep.has(block.name.toLowerCase())) updated = stripBlock(updated, block)
  }
  const listenerBlocks = parseOlsBlocks(updated, "listener").reverse()
  for (const block of listenerBlocks) {
    const safeBlock = block.text.replace(/^\s*map\s+(\S+)\s+[^\n]*(?:\n|$)/gm, (line, name) =>
      keep.has(name.toLowerCase()) ? line : ""
    )
    updated = updated.slice(0, block.start) + safeBlock + updated.slice(block.end)
  }
  return updated
}

function unifiedDiff(file, before, after) {
  if (before === after) return ""
  const oldLines = String(before || "").split(/\r?\n/)
  const newLines = String(after || "").split(/\r?\n/)
  if (oldLines.length * newLines.length > 250000)
    return `--- ${file}\n+++ ${file}\n(contents differ; file too large for inline diff)`
  const table = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1)
  )
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const output = [`--- a${file}`, `+++ b${file}`]
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      output.push(` ${oldLines[i]}`)
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) output.push(`-${oldLines[i++]}`)
    else output.push(`+${newLines[j++]}`)
  }
  while (i < oldLines.length) output.push(`-${oldLines[i++]}`)
  while (j < newLines.length) output.push(`+${newLines[j++]}`)
  return output.join("\n")
}

function depsInNginx(config) {
  const inputs = [
    config.nginxMain,
    ...listTree(config.nginxConfD)
      .filter((x) => x.type === "file")
      .map((x) => x.path),
  ]
  const text = inputs.map((file) => readText(file) || "").join("\n")
  return {
    badBot: /\bmap\s+[^;{]*\$bad_bot\b/.test(text),
    geoip: /geoip-country-map\.conf|\bmap\s+\$geoip2_data_country_code\s+\$block_country\b/.test(
      text
    ),
    cacheZone:
      /\bproxy_cache_path\b[^;]*\bkeys_zone\s*=\s*cache_zone\b|cache-proxy-zone-active\.conf/.test(
        text
      ),
    apiLimit: /\blimit_req_zone\b[^;]*\bzone\s*=\s*api_limit\b/.test(text),
  }
}

function managerOptions(config) {
  const namesFrom = (file, minimumUid = 0) => {
    try {
      return fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.split(":"))
        .filter(
          (parts) =>
            parts.length >= 4 && (parts[0] === "www-data" || Number(parts[2]) >= minimumUid)
        )
        .map(([name]) => name)
        .sort()
    } catch {
      return []
    }
  }
  const handlers = new Set([config.phpBinary])
  if (!config.testMode) {
    try {
      for (const name of fs.readdirSync(config.olsRoot).filter((item) => /^lsphp\d+$/.test(item))) {
        const binary = path.join(config.olsRoot, name, "bin/lsphp")
        if (exists(binary)) handlers.add(binary)
      }
    } catch (error) {
      if (!["ENOENT", "EACCES"].includes(error.code)) throw error
    }
  }
  const profiles = new Set([config.phpIni])
  for (const handler of handlers) {
    const versionRoot = path.dirname(path.dirname(handler))
    const version = path
      .basename(handler.match(/^(.*)\/bin\/lsphp$/)?.[1] || versionRoot)
      .replace(/^lsphp/, "")
    for (const candidate of [
      path.join(
        versionRoot,
        "etc/php",
        `${version.slice(0, 1)}.${version.slice(1)}`,
        "litespeed/php.ini"
      ),
      path.join(versionRoot, "etc/php.ini"),
    ])
      if (exists(candidate)) profiles.add(candidate)
  }
  const phpIniProfiles = [...profiles].filter((item) => config.testMode || exists(item))
  return {
    paths: {
      nginxAvailable: config.nginxAvailable,
      nginxEnabled: config.nginxEnabled,
      olsRoot: config.olsRoot,
      olsMain: config.olsMain,
      olsVhosts: config.olsVhosts,
      phpIniScanDir: config.phpIniScanDir,
      acmeHome: config.acmeHome,
      homeRoot: config.homeRoot,
      mysqlBinary: config.mysqlBinary,
      template: "Vhost Manager boilerplates",
    },
    users: namesFrom("/etc/passwd", 1000),
    groups: namesFrom("/etc/group", 1),
    phpHandlers: [...handlers].filter((item) => config.testMode || exists(item)),
    phpIniProfiles,
    phpIniValues: Object.fromEntries(
      phpIniProfiles.map((profile) => [profile, readPhpIniValues(readText(profile) || "")])
    ),
    listeners: parseOlsBlocks(readText(config.olsMain) || "", "listener").map((item) => item.name),
    upstreams: ["127.0.0.1:8088"],
    globalCspPolicy: DEFAULT_CSP_POLICY,
  }
}

function siteDetails(config, domain, manifest = {}) {
  const normalized =
    String(domain || "").toLowerCase() === "phpmyadmin" ? "phpmyadmin" : validDomain(domain)
  if (!normalized) throw new Error("Enter a valid domain name.")
  const result = inventory(config, manifest)
  const site = result.sites.find((item) => item.domain === normalized)
  if (!site) throw new Error(`No discovered vhost exists for ${normalized}.`)
  const files = [
    ...site.nginxConfigs,
    ...site.olsVhosts.map((item) => item.path).filter(Boolean),
    path.join(config.nginxAvailable, `${normalized}.conf`),
    path.join(config.nginxAvailable, "vhost_ssl", `${normalized}_ssl.conf`),
  ]
  const uniqueFiles = [...new Set(files)].filter(exists).map((file) => {
    let content = readText(file) || "(binary or unreadable file)"
    content = content.replace(
      /^(\s*(?:password|passwd|secret|api[_-]?key|token)\s+).+$/gim,
      "$1[redacted]"
    )
    return {
      path: file,
      content: content.slice(0, 64 * 1024),
      truncated: content.length > 64 * 1024,
    }
  })
  const olsDocRoot = site.olsVhosts
    .map((item) => readText(item.path || "")?.match(/^\s*docRoot\s+([^\s#]+)/m)?.[1])
    .find(Boolean)
  const webroot =
    site.webroot || olsDocRoot || path.join(config.homeRoot, normalized, "public_html")
  let entries = []
  try {
    entries = fs
      .readdirSync(webroot, { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if (!["ENOENT", "EACCES"].includes(error.code)) throw error
  }
  return {
    domain: normalized,
    webroot,
    files: uniqueFiles,
    entries,
    managed: site.managed,
    drifted: site.drifted,
  }
}

function readMimeTypes(config, overrides = []) {
  const source = readText(config.mimeTypesFile) || ""
  const types = new Map()
  for (const line of source.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([a-zA-Z0-9.+/-]+)\s+([^;]+);/)
    if (!match) continue
    for (const extension of match[2].trim().split(/\s+/))
      types.set(extension.toLowerCase(), match[1])
  }
  for (const row of overrides) {
    const match = String(row)
      .trim()
      .match(/^([a-zA-Z0-9.+/-]+)\s+([a-zA-Z0-9.\s-]+)$/)
    if (!match) throw new Error(`Invalid custom MIME mapping: ${row}`)
    for (const extension of match[2].trim().split(/\s+/))
      types.set(extension.toLowerCase().replace(/^\./, ""), match[1])
  }
  const grouped = new Map()
  for (const [extension, type] of types) {
    if (!grouped.has(type)) grouped.set(type, [])
    grouped.get(type).push(extension)
  }
  return [...grouped].map(([type, extensions]) => `    ${type} ${extensions.join(" ")};`).join("\n")
}

function renderBoilerplate(name, variables, config = DEFAULTS) {
  const source = readText(path.join(config.boilerplateDir || DEFAULTS.boilerplateDir, name))
  if (source === null) throw new Error(`Required boilerplate is missing: ${name}`)
  for (const [, key] of source.matchAll(/{{([^{}]+)}}/g)) {
    if (!/^[A-Z0-9_]+$/.test(key))
      throw new Error(`Invalid boilerplate variable {{${key}}} in ${name}.`)
    if (!Object.hasOwn(variables, key))
      throw new Error(`No value supplied for {{${key}}} in ${name}.`)
  }
  const rendered = source.replace(/{{([A-Z0-9_]+)}}/g, (token, key) => {
    return String(variables[key])
  })
  return rendered
}

function renderFromEaglesvn(domain, aliases, webroot, cert, key, config, options = {}) {
  const names = [domain, ...aliases].join(" ")
  const stem = domain.replace(/[^a-z0-9]+/g, "_")
  const deps = depsInNginx(config)
  const policy = String(options.cspPolicy || DEFAULT_CSP_POLICY)
    .replace(/[\r\n"\\]/g, " ")
    .trim()
  const cspHeader =
    options.cspMode === "off"
      ? null
      : options.cspMode === "enforce"
        ? "Content-Security-Policy"
        : "Content-Security-Policy-Report-Only"
  const hsts =
    options.hsts === false
      ? ""
      : '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n'
  const frame = ["DENY", "SAMEORIGIN"].includes(options.frameOptions)
    ? options.frameOptions
    : "SAMEORIGIN"
  const referrer = [
    "no-referrer",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
  ].includes(options.referrerPolicy)
    ? options.referrerPolicy
    : "strict-origin"
  const permissions = String(
    options.permissionsPolicy || "geolocation=(), microphone=(), camera=()"
  )
    .replace(/[\r\n"\\]/g, " ")
    .trim()
  if (!/^[a-zA-Z0-9=(),;\s*.-]+$/.test(permissions) || permissions.length > 500)
    throw new Error("Permissions Policy contains unsupported characters or is too long.")
  const defaultPermissions = "geolocation=(), microphone=(), camera=()"
  const useSecuritySnippet =
    !config.testMode &&
    exists("/etc/nginx/snippets/security-headers.conf") &&
    frame === "SAMEORIGIN" &&
    referrer === "strict-origin" &&
    permissions === defaultPermissions
  const security = `    add_header X-Content-Type-Options nosniff always;\n    add_header X-Frame-Options ${frame} always;\n    add_header Referrer-Policy "${referrer}" always;\n    add_header Permissions-Policy "${permissions}" always;`
  const securityBase = useSecuritySnippet
    ? "    include /etc/nginx/snippets/security-headers.conf;"
    : security
  const securityHeaders = `    # Security Headers\n${securityBase}${hsts ? `\n${hsts.trimEnd()}` : ""}${cspHeader ? `\n    add_header ${cspHeader} "${policy}" always;` : ""}`
  const mimeTypes = options.mimeOverrides?.length
    ? `    # Site MIME mappings merged with the host mime.types file.\n    types {\n${readMimeTypes(config, options.mimeOverrides)}\n    }`
    : ""
  const duration =
    options.staticCache === "30d" ? "30d" : options.staticCache === "1h" ? "1h" : "5m"
  const developmentCache =
    options.staticCache === "dev" ? "    include /etc/nginx/snippets/cache-policy-dev.conf;" : ""
  const developmentHttpCache =
    options.staticCache === "dev"
      ? "        include /etc/nginx/snippets/cache-policy-dev.conf;\n"
      : ""
  const staticCache =
    options.staticCache === "dev"
      ? developmentCache
      : options.staticCache && options.staticCache !== "off"
        ? `    # Browser cache for static assets; dynamic responses remain uncached.\n    location ~* \\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf)$ {\n        expires ${duration};\n        proxy_pass http://${options.upstream || "127.0.0.1:8088"};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_buffering on;\n    }`
        : ""
  const proxyCache =
    deps.cacheZone && options.proxyCache && options.staticCache !== "dev"
      ? `        proxy_cache cache_zone;\n        proxy_cache_key "$scheme$request_method$host$request_uri$is_args$args";\n        proxy_cache_methods GET HEAD;\n        proxy_cache_valid 200 10m;\n        proxy_cache_use_stale error timeout updating;\n        proxy_cache_bypass $http_cache_control $http_authorization $http_cookie $query_string;\n        proxy_no_cache $http_cache_control $http_authorization $http_cookie $query_string $upstream_http_set_cookie;`
      : ""
  const rateLimit = deps.apiLimit
    ? "        limit_req zone=api_limit burst=40 nodelay;\n        limit_req_status 429;"
    : ""
  const badBot = deps.badBot
    ? '    if ($bad_bot = 1) {\n        return 403 "Forbidden: Malicious bot detected.";\n    }'
    : ""
  const geoipBlock = deps.geoip
    ? "        include /etc/nginx/snippets/geoip-country-block.conf;\n"
    : ""
  const httpRedirect =
    options.httpRedirect === false
      ? ""
      : `    location / {\n${geoipBlock}        return 301 https://$host$request_uri;\n    }`
  const variables = {
    SERVER_NAMES: names,
    WEBROOT: `${webroot.replace(/\/$/, "")}/`,
    HTTP_REDIRECT: httpRedirect,
    ERROR_LOG_80: options.nginxErrorLog || `/var/log/nginx/${stem}_error_80.log`,
    ACCESS_LOG_80: options.nginxAccessLog || `/var/log/nginx/${stem}_access_80.log`,
    CERTIFICATE_PATH: cert,
    PRIVATE_KEY_PATH: key,
    SECURITY_HEADERS: securityHeaders,
    MIME_TYPES: mimeTypes,
    STATIC_CACHE: staticCache,
    BAD_BOT_BLOCK: badBot,
    GEOIP_BLOCK: geoipBlock.trimEnd(),
    HTTP_GEOIP_BLOCK: geoipBlock,
    UPSTREAM: options.upstream || "127.0.0.1:8088",
    PROXY_CACHE: proxyCache,
    RATE_LIMIT: rateLimit,
    ERROR_LOG_443: options.nginxErrorLog || `/var/log/nginx/${stem}_error_443.log`,
    ACCESS_LOG_443: options.nginxAccessLog || `/var/log/nginx/${stem}_access_443.log`,
  }
  const production = renderBoilerplate("nginx-production.conf.tpl", variables, config)
  const stage = renderBoilerplate(
    "nginx-ssl-renewal.conf.tpl",
    {
      SERVER_NAMES: names,
      WEBROOT: `${webroot.replace(/\/$/, "")}/`,
      HTTP_GEOIP_BLOCK: geoipBlock,
      HTTP_CACHE_POLICY: developmentHttpCache,
      UPSTREAM: "127.0.0.1:8088",
      RENEWAL_ERROR_LOG: options.nginxErrorLog || `/var/log/nginx/${stem}_renewal_error.log`,
      RENEWAL_ACCESS_LOG: options.nginxAccessLog || `/var/log/nginx/${stem}_renewal_access.log`,
    },
    config
  )
  return { production, stage, deps }
}

function setListenerMap(source, listenerName, vhost, domains) {
  const block = parseOlsBlocks(source, "listener").find((item) => item.name === listenerName)
  if (!block) throw new Error(`OpenLiteSpeed listener '${listenerName}' was not found.`)
  const mapLine = `  map ${vhost} ${domains.join(" ")}\n`
  const existing = new RegExp(
    `^([\\t ]*map\\s+)${vhost.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s+[^\\n]*(?:\\n|$)`,
    "m"
  )
  if (existing.test(block.text)) {
    const replaced = block.text.replace(existing, `${mapLine}`)
    return source.slice(0, block.start) + replaced + source.slice(block.end)
  }
  const close = block.text.lastIndexOf("}")
  const newBlock = `${block.text.slice(0, close)}${mapLine}${block.text.slice(close)}`
  return source.slice(0, block.start) + newBlock + source.slice(block.end)
}

function insertOlsVhost(
  source,
  vhost,
  webroot,
  aliases,
  listenerName = "Default",
  config = DEFAULTS
) {
  if (parseOlsBlocks(source, "virtualhost").some((block) => block.name === vhost))
    throw new Error(`OpenLiteSpeed vhost '${vhost}' already exists.`)
  const root = `${webroot.replace(/\/public_html\/?$/, "")}/`
  const block = renderBoilerplate(
    "ols-main-vhost.conf.tpl",
    { VHOST_NAME: vhost, VH_ROOT: root },
    config
  )
  let next = `${source.trimEnd()}\n\n${block.trim()}\n`
  next = setListenerMap(next, listenerName, vhost, [vhost, ...aliases])
  return next
}

function removeOlsVhost(source, vhost) {
  let updated = source
  const block = parseOlsBlocks(updated, "virtualhost").find((item) => item.name === vhost)
  if (block) updated = stripBlock(updated, block)
  for (const listener of parseOlsBlocks(updated, "listener").reverse()) {
    const cleaned = listener.text.replace(
      new RegExp(
        `^\\s*map\\s+${vhost.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s+[^\\n]*(?:\\n|$)`,
        "gm"
      ),
      ""
    )
    updated = updated.slice(0, listener.start) + cleaned + updated.slice(listener.end)
  }
  return updated
}

function renderOlsVhost(
  domain,
  aliases,
  webroot,
  user,
  phpPath,
  phpIni,
  scanDir,
  group = user,
  config = DEFAULTS
) {
  const root = `${webroot.replace(/\/public_html\/?$/, "")}/`
  const handler = `lsphp_${domain.replace(/[^a-zA-Z0-9]/g, "_")}`
  const socket = `/tmp/lshttpd/${handler}.sock`
  return renderBoilerplate(
    "ols-vhost.conf.tpl",
    {
      WEBROOT: webroot.replace(/\/$/, ""),
      DOMAIN: domain,
      ALIASES: aliases.join(" "),
      OLS_ERROR_LOG: path.join(config.olsLogDir || DEFAULTS.olsLogDir, `${domain}_error.log`),
      OLS_ACCESS_LOG: path.join(config.olsLogDir || DEFAULTS.olsLogDir, `${domain}_access.log`),
      PHP_HANDLER: handler,
      PHP_SOCKET: socket,
      PHP_INI: phpIni,
      PHP_SCAN_DIR: scanDir,
      PHP_BINARY: phpPath,
      SITE_USER: user,
      SITE_GROUP: group,
      SITE_ROOT: root.replace(/\/$/, ""),
    },
    config
  )
}

function htmlEscape(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function resetPlan(config) {
  const available = listTree(config.nginxAvailable)
  const enabled = listTree(config.nginxEnabled)
  const olsTree = listTree(config.olsVhosts)
  const mainBefore = readText(config.olsMain) || ""
  const mainAfter = resetOlsConfig(mainBefore)
  const keepNginxEntry = (entry) => {
    if (/phpmyadmin/i.test(entry.relative)) return true
    if (entry.type === "file")
      return parseServerNames(readText(entry.path) || "").some((name) => /phpmyadmin/i.test(name))
    if (entry.type === "symlink") {
      try {
        return /phpmyadmin/i.test(fs.readlinkSync(entry.path))
      } catch {
        return false
      }
    }
    return false
  }
  const targets = [
    ...available
      .filter((entry) => !keepNginxEntry(entry))
      .map((entry) => ({ ...entry, action: "remove" })),
    ...enabled
      .filter((entry) => !keepNginxEntry(entry))
      .map((entry) => ({ ...entry, action: "remove" })),
    ...olsTree
      .filter(
        (entry) =>
          entry.relative !== "phpmyadmin" && !entry.relative.startsWith(`phpmyadmin${path.sep}`)
      )
      .map((entry) => ({ ...entry, action: "remove" })),
  ]
  const unique = [...new Map(targets.map((entry) => [entry.path, entry])).values()]
  const files = unique
    .filter((entry) => entry.type !== "directory")
    .map((entry) => ({
      path: entry.path,
      action: "remove",
      type: entry.type,
      before:
        entry.type === "symlink"
          ? `symlink -> ${fs.readlinkSync(entry.path)}`
          : readText(entry.path) || "(binary or unreadable file)",
      after: "",
      hash: fileHash(entry.path),
    }))
  const globalConfig = {
    path: config.olsMain,
    action: "update",
    before: mainBefore,
    after: mainAfter,
    hash: fileHash(config.olsMain),
  }
  const brokenNginxLinks = enabled
    .filter((entry) => entry.type === "symlink")
    .filter((entry) => {
      const target = fs.readlinkSync(entry.path)
      return !fs.existsSync(path.resolve(path.dirname(entry.path), target))
    })
    .map((entry) => entry.path)
  const staleOls = parseOlsBlocks(mainBefore, "virtualhost")
    .filter(
      (block) =>
        !fs.existsSync(
          path.resolve(config.olsRoot, block.text.match(/^\s*configFile\s+([^\s#]+)/m)?.[1] || "")
        )
    )
    .map((block) => block.name)
  const planId = crypto.randomUUID()
  return {
    id: planId,
    kind: "reset",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    title: "Reset site vhosts (phpMyAdmin preserved)",
    confirmation: "RESET SITE VHOSTS",
    archivePath: path.join(config.backupDir, "archive", planId),
    summary:
      "Archive exact copies of the discovered example configs, then clear those active site config paths while preserving the complete phpMyAdmin vhost and listener.",
    files: [...files, globalConfig],
    removePaths: unique.filter((entry) => entry.type !== "directory").map((entry) => entry.path),
    directories: [
      ...new Set(unique.filter((entry) => entry.type === "directory").map((entry) => entry.path)),
    ].sort((a, b) => b.length - a.length),
    warnings: [
      ...(brokenNginxLinks.length
        ? [`Broken Nginx links will be removed: ${brokenNginxLinks.join(", ")}`]
        : []),
      ...(staleOls.length ? [`OLS references missing vhost configs: ${staleOls.join(", ")}`] : []),
      "Discovered configurations are treated as reference examples. Exact copies, including the prior OLS main config, are retained in the archive path shown above.",
      "Website files and ACME accounts/certificates are not included in this reset.",
    ],
    preserve: [
      "/usr/local/lsws/conf/vhosts/phpmyadmin",
      "/opt/phpmyadmin",
      "the OLS phpMyAdmin listener and credentials",
    ],
    fingerprint: Object.fromEntries(
      [...unique.map((entry) => entry.path), config.olsMain].map((file) => [file, fileHash(file)])
    ),
    templateDiff: unifiedDiff(config.olsMain, mainBefore, mainAfter),
  }
}

function sitePlan(config, input, currentInventory, manifest = {}) {
  const domain = validDomain(input.domain)
  if (!domain) throw new Error("Enter a valid fully qualified domain name.")
  const rawAliases = Array.isArray(input.aliases)
    ? input.aliases
    : String(input.aliases || "")
        .split(/[\s,]+/)
        .filter(Boolean)
  const parsedAliases = rawAliases.map(validDomain)
  if (parsedAliases.some((name) => !name))
    throw new Error("Every alias must be a valid fully qualified domain name.")
  const aliases = [...new Set(parsedAliases.filter((name) => name !== domain))]
  const homeRoot = config.homeRoot || "/home"
  const olsLogDir = config.olsLogDir || DEFAULTS.olsLogDir
  const webroot = path.resolve(
    String(input.webroot || path.join(homeRoot, domain, "public_html")).trim()
  )
  const siteHome = path.resolve(homeRoot, domain)
  if (!webroot.startsWith(`${siteHome}${path.sep}`))
    throw new Error(`Webroot must remain inside ${siteHome}.`)
  const managedSite = manifest.sites?.[domain] || null
  const databaseEnabled = input.createDatabase === true
  let database = { enabled: false }
  if (databaseEnabled) {
    if (managedSite) throw new Error("Database creation is available when creating a new site.")
    const name = String(input.databaseName || "").trim()
    const user = String(input.databaseUser || "").trim()
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(name))
      throw new Error("Database name must be 1–64 letters, numbers, or underscores.")
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(user))
      throw new Error(
        "Database user must be 1–32 letters, numbers, or underscores and start with a letter or underscore."
      )
    database = { enabled: true, name, user, host: "localhost", engine: "MySQL/MariaDB" }
  }
  const oldFirewallPorts = managedSite?.settings?.firewallPorts || { tcp: [], udp: [] }
  const firewallPorts = {
    tcp: parseFirewallPorts(input.tcpPorts ?? oldFirewallPorts.tcp, "tcp"),
    udp: parseFirewallPorts(input.udpPorts ?? oldFirewallPorts.udp, "udp"),
  }
  const firewallChanged =
    JSON.stringify(firewallPorts) !==
    JSON.stringify({
      tcp: [...(oldFirewallPorts.tcp || [])].sort((a, b) => a - b),
      udp: [...(oldFirewallPorts.udp || [])].sort((a, b) => a - b),
    })
  const defaultAccount = managedSite?.settings?.account || accountForDomain(domain)
  if (input.owner && input.owner !== "dedicated")
    throw new Error("Every managed site must use its dedicated site account.")
  const account = defaultAccount
  const group = account
  const reusedSiteAccount = Object.entries(manifest.sites || {}).find(
    ([siteDomain, site]) => siteDomain !== domain && site.settings?.account === account
  )
  if (reusedSiteAccount)
    throw new Error(
      `The account ${account} is already assigned to ${reusedSiteAccount[0]}; each site requires its own Unix account.`
    )
  if (input.group && input.group !== "dedicated" && input.group !== account)
    throw new Error("Every managed site must use its dedicated account as its primary group.")
  if (managedSite && managedSite.settings?.owner && managedSite.settings.owner !== "dedicated")
    throw new Error(
      "This managed site uses a shared account. Migrate it to a dedicated site account before editing it."
    )
  const directoryMode =
    typeof input.directoryMode === "number"
      ? input.directoryMode
      : parseInt(String(input.directoryMode || "0755"), 8)
  const fileMode =
    typeof input.fileMode === "number"
      ? input.fileMode
      : parseInt(String(input.fileMode || "0644"), 8)
  const directoryModeText = directoryMode.toString(8).padStart(4, "0")
  const fileModeText = fileMode.toString(8).padStart(4, "0")
  if (![0o750, 0o755, 0o770, 0o775].includes(directoryMode))
    throw new Error("Choose a supported directory permission preset.")
  if (![0o640, 0o644, 0o660, 0o664].includes(fileMode))
    throw new Error("Choose a supported file permission preset.")
  const requestMode = ["ols", "proxy", "static"].includes(input.requestMode)
    ? input.requestMode
    : "ols"
  const upstream = String(input.upstream || "127.0.0.1:8088").trim()
  const upstreamMatch = upstream.match(/^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/i)
  if (requestMode === "proxy" && !upstreamMatch)
    throw new Error("Upstream must use loopback, for example 127.0.0.1:8088.")
  if (requestMode === "proxy" && Number(upstreamMatch[1]) > 65535)
    throw new Error("Upstream port must be between 1 and 65535.")
  if (input.htaccess && requestMode !== "ols")
    throw new Error("The .htaccess template applies only to an OpenLiteSpeed managed vhost.")
  const previousMode = managedSite?.settings?.requestMode || "ols"
  if (!managedSite && exists(siteHome))
    throw new Error(
      `The site home already exists: ${siteHome}. Inspect it before provisioning so existing data and ownership remain untouched.`
    )
  if (managedSite?.adoptedReadOnly)
    throw new Error(
      "This discovered vhost is adopted read-only. Convert it from a reviewed template before editing server files."
    )
  const effectiveAliases = aliases.length ? aliases : [`www.${domain}`]
  const names = [domain, ...effectiveAliases]
  const conflicts = currentInventory.sites.filter(
    (site) =>
      site.domain !== domain &&
      names.some((name) => site.domain === name || site.aliases.includes(name)) &&
      site.domain !== "phpmyadmin"
  )
  if (conflicts.length)
    throw new Error(
      `A vhost already uses ${conflicts.map((site) => site.domain).join(", ")}. Review the discovered entry before changing it.`
    )
  if (
    !managedSite &&
    currentInventory.sites.some((site) => site.domain === domain && site.domain !== "phpmyadmin")
  )
    throw new Error(
      `A vhost already uses ${domain}. Review or adopt the discovered entry before changing it.`
    )
  const phpIni = String(input.phpIni || config.phpIni)
  if (!exists(phpIni) && !config.testMode)
    throw new Error(`The OLS PHP ini template is missing: ${phpIni}`)
  const cert = String(
    input.certificatePath || `${config.acmeHome}/${domain}_ecc/fullchain.cer`
  ).trim()
  const key = String(
    input.privateKeyPath || `${config.acmeHome}/${domain}_ecc/${domain}.key`
  ).trim()
  if (
    (!cert.startsWith(`${config.acmeHome}/`) ||
      !path.resolve(cert).startsWith(`${path.resolve(config.acmeHome)}${path.sep}`)) &&
    !config.testMode
  )
    throw new Error("Certificate paths must stay under the ACME home directory.")
  if (
    (!key.startsWith(`${config.acmeHome}/`) ||
      !path.resolve(key).startsWith(`${path.resolve(config.acmeHome)}${path.sep}`)) &&
    !config.testMode
  )
    throw new Error("Private-key paths must stay under the ACME home directory.")
  for (const [label, logPath] of [
    ["access", input.nginxAccessLog],
    ["error", input.nginxErrorLog],
  ]) {
    if (logPath && !/^\/var\/log\/nginx\/[A-Za-z0-9._/-]+$/.test(String(logPath)))
      throw new Error(`Nginx ${label} log must be a safe path under /var/log/nginx/.`)
  }
  const cspMode = ["off", "report-only", "enforce"].includes(input.cspMode)
    ? input.cspMode
    : "report-only"
  const cspSource =
    input.cspSource === "global" || (!input.cspSource && !input.cspPolicy) ? "global" : "custom"
  const cspPolicy = String(
    cspSource === "global" ? DEFAULT_CSP_POLICY : input.cspPolicy || DEFAULT_CSP_POLICY
  )
  const cspDirectives = cspPolicy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
  if (
    !/^[\x20-\x7E\r\n\t]+$/.test(cspPolicy) ||
    /["\\$]/.test(cspPolicy) ||
    cspPolicy.length > 5000 ||
    !cspDirectives.length ||
    cspDirectives.some((directive) => !/^[a-z][a-z0-9-]*(?:\s+.+)?$/i.test(directive))
  )
    throw new Error("CSP policy contains unsupported characters or is too long.")
  const security = {
    cspSource,
    cspMode,
    cspPolicy,
    hsts: input.hsts !== false,
    frameOptions: input.frameOptions || "SAMEORIGIN",
    referrerPolicy: input.referrerPolicy || "strict-origin",
    permissionsPolicy: input.permissionsPolicy || "geolocation=(), microphone=(), camera=()",
    mimeOverrides: Array.isArray(input.mimeOverrides)
      ? input.mimeOverrides
      : String(input.mimeOverrides || "")
          .split(/\r?\n/)
          .filter(Boolean),
    staticCache: ["off", "dev", "5m", "1h", "30d"].includes(input.staticCache)
      ? input.staticCache
      : "1h",
    proxyCache: Boolean(input.proxyCache) && input.staticCache !== "dev",
  }
  if (security.mimeOverrides.length && !exists(config.mimeTypesFile))
    throw new Error(`System MIME types file is missing: ${config.mimeTypesFile}`)
  const listener = String(input.olsListener || "Default")
  if (
    !parseOlsBlocks(readText(config.olsMain) || "", "listener").some(
      (item) => item.name === listener
    )
  )
    throw new Error(`OpenLiteSpeed listener '${listener}' was not found.`)
  const phpBinary = String(input.phpBinary || config.phpBinary)
  const phpIniProfile = String(input.phpIni || config.phpIni)
  const allowedHandlers = managerOptions(config).phpHandlers
  const allowedIni = managerOptions(config).phpIniProfiles
  if (
    requestMode === "ols" &&
    (!allowedHandlers.includes(phpBinary) || !allowedIni.includes(phpIniProfile))
  )
    throw new Error("Choose an available PHP handler and ini profile.")
  const templates = renderFromEaglesvn(domain, effectiveAliases, webroot, cert, key, config, {
    ...security,
    upstream: requestMode === "proxy" ? upstream : "127.0.0.1:8088",
    httpRedirect: input.httpRedirect !== false,
    nginxAccessLog: input.nginxAccessLog,
    nginxErrorLog: input.nginxErrorLog,
    requestMode,
  })
  const olsMainBefore = readText(config.olsMain) || ""
  const olsMainAfter =
    requestMode === "ols"
      ? managedSite && previousMode === "ols"
        ? setListenerMap(olsMainBefore, listener, domain, [domain, ...effectiveAliases])
        : insertOlsVhost(olsMainBefore, domain, webroot, effectiveAliases, listener, config)
      : managedSite && previousMode === "ols"
        ? removeOlsVhost(olsMainBefore, domain)
        : olsMainBefore
  const phpSettings = buildPhpIniOverrides(input)
  const phpIniContent = renderBoilerplate(
    "php.ini.tpl",
    {
      PHP_PROFILE_CONTENT: readText(phpIni) || "[PHP]\n",
      PHP_SITE_OVERRIDES: phpSettings.content || "; no per-site overrides",
    },
    config
  )
  let siteFiles = [
    ...(requestMode === "ols"
      ? [
          {
            path: path.join(olsLogDir, `${domain}_error.log`),
            action: "create",
            content: "",
            mode: 0o640,
            owner: "nobody",
            group: "nogroup",
          },
          {
            path: path.join(olsLogDir, `${domain}_access.log`),
            action: "create",
            content: "",
            mode: 0o640,
            owner: "nobody",
            group: "nogroup",
          },
        ].filter((file) => !exists(file.path))
      : []),
    ...(input.placeholder !== false
      ? [
          {
            path: path.join(webroot, "index.html"),
            action: "create",
            content: renderBoilerplate(
              "placeholder.html.tpl",
              { SITE_TITLE: htmlEscape(input.label || domain) },
              config
            ),
            mode: fileMode,
            owner: account,
            group,
          },
        ]
      : []),
    ...(input.robots !== "omit"
      ? [
          {
            path: path.join(webroot, "robots.txt"),
            action: "create",
            content: renderBoilerplate(
              input.robots === "block" ? "robots-block.txt.tpl" : "robots-allow.txt.tpl",
              {},
              config
            ),
            mode: fileMode,
            owner: account,
            group,
          },
        ]
      : []),
    ...(input.htaccess
      ? [
          {
            path: path.join(webroot, ".htaccess"),
            action: "create",
            content: renderBoilerplate("htaccess.tpl", { DOMAIN: domain }, config),
            mode: fileMode,
            owner: account,
            group,
          },
        ]
      : []),
    {
      path: path.join(config.olsVhosts, domain, "vhconf.conf"),
      action: "create",
      content: renderOlsVhost(
        domain,
        aliases.length ? aliases : [`www.${domain}`],
        webroot,
        account,
        phpBinary,
        path.join(siteHome, ".site-config/php.ini"),
        config.phpIniScanDir,
        group,
        config
      ),
      mode: 0o640,
      owner: "lsadm",
      group: "nogroup",
    },
    {
      path: path.join(siteHome, ".site-config/php.ini"),
      action: "create",
      content: phpIniContent,
      mode: 0o640,
      owner: account,
      group,
    },
    {
      path: path.join(config.nginxAvailable, `${domain}.conf`),
      action: "create",
      content: templates.production,
      mode: 0o640,
      owner: "root",
    },
    {
      path: path.join(config.nginxAvailable, "vhost_ssl", `${domain}_ssl.conf`),
      action: "create",
      content: templates.stage,
      mode: 0o640,
      owner: "root",
    },
    { path: config.olsMain, action: "update", content: olsMainAfter, mode: null, owner: null },
    {
      path: path.join(config.nginxEnabled, `${domain}_ssl.conf`),
      action: "symlink",
      target: path.join(config.nginxAvailable, "vhost_ssl", `${domain}_ssl.conf`),
      mode: null,
      owner: "root",
    },
  ].filter(
    (file) =>
      requestMode === "ols" ||
      (file.path !== path.join(config.olsVhosts, domain, "vhconf.conf") &&
        file.path !== path.join(siteHome, ".site-config/php.ini") &&
        file.path !== config.olsMain)
  )
  if (firewallChanged && (managedSite || firewallPorts.tcp.length || firewallPorts.udp.length)) {
    for (const [family, rulesPath] of [
      ["IPv4", config.iptablesRulesV4],
      ["IPv6", config.iptablesRulesV6],
    ]) {
      const before = readText(rulesPath)
      if (before == null && !config.testMode)
        throw new Error(`Could not read the ${family} iptables-persistent rules file: ${rulesPath}`)
      const source = before ?? "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n"
      const after = ["tcp", "udp"].reduce(
        (text, protocol) =>
          updatePersistentFirewall(text, domain, firewallPorts[protocol], protocol),
        source
      )
      siteFiles.push({
        path: rulesPath,
        action: exists(rulesPath) ? "update" : "create",
        content: after,
      })
    }
  }
  if (requestMode !== "ols" && managedSite && previousMode === "ols") {
    for (const target of [
      path.join(config.olsVhosts, domain, "vhconf.conf"),
      path.join(siteHome, ".site-config/php.ini"),
    ]) {
      if (exists(target))
        siteFiles.push({ path: target, action: "remove", content: "", mode: null, owner: null })
    }
    siteFiles.push({
      path: config.olsMain,
      action: "update",
      content: olsMainAfter,
      mode: null,
      owner: null,
    })
  }
  for (const file of siteFiles) {
    if (
      file.path === path.join(webroot, "index.html") ||
      file.path === path.join(webroot, "robots.txt")
    )
      continue
    if (
      file.path === path.join(config.nginxAvailable, `${domain}.conf`) ||
      file.path === path.join(config.nginxAvailable, "vhost_ssl", `${domain}_ssl.conf`)
    ) {
      file.content = file.content
        .replaceAll(
          "/var/log/nginx/" + domain.replace(/[^a-z0-9]+/g, "_") + "_error_80.log",
          String(
            input.nginxErrorLog || `/var/log/nginx/${domain.replace(/[^a-z0-9]+/g, "_")}_error.log`
          )
        )
        .replaceAll(
          "/var/log/nginx/" + domain.replace(/[^a-z0-9]+/g, "_") + "_error_443.log",
          String(
            input.nginxErrorLog || `/var/log/nginx/${domain.replace(/[^a-z0-9]+/g, "_")}_error.log`
          )
        )
        .replaceAll(
          "/var/log/nginx/" + domain.replace(/[^a-z0-9]+/g, "_") + "_access_80.log",
          String(
            input.nginxAccessLog ||
              `/var/log/nginx/${domain.replace(/[^a-z0-9]+/g, "_")}_access.log`
          )
        )
        .replaceAll(
          "/var/log/nginx/" + domain.replace(/[^a-z0-9]+/g, "_") + "_access_443.log",
          String(
            input.nginxAccessLog ||
              `/var/log/nginx/${domain.replace(/[^a-z0-9]+/g, "_")}_access.log`
          )
        )
      if (requestMode === "static")
        file.content = file.content.replace(
          /proxy_pass http:\/\/127\.0\.0\.1:8088;/g,
          "try_files $uri $uri/ =404;"
        )
      if (
        file.path === path.join(config.nginxAvailable, `${domain}.conf`) &&
        input.httpRedirect === false
      )
        file.content = file.content.replace(
          /\s*location \/ \{\n\s*return 301 https:\/\/\$host\$request_uri;\n\s*\}\n/g,
          ""
        )
    }
  }
  if (managedSite) {
    const generatedPaths = new Set([
      path.join(config.olsVhosts, domain, "vhconf.conf"),
      path.join(olsLogDir, `${domain}_error.log`),
      path.join(olsLogDir, `${domain}_access.log`),
      path.join(siteHome, ".site-config/php.ini"),
      path.join(config.nginxAvailable, `${domain}.conf`),
      path.join(config.nginxAvailable, "vhost_ssl", `${domain}_ssl.conf`),
      config.iptablesRulesV4,
      config.iptablesRulesV6,
    ])
    siteFiles = siteFiles.filter(
      (file) =>
        generatedPaths.has(file.path) ||
        file.path.endsWith(`/${domain}/.htaccess`) ||
        file.path === config.olsMain
    )
    for (const file of siteFiles) {
      if (file.path === config.olsMain) continue
      if (file.action === "remove") continue
      const currentHash = fileHash(file.path)
      const expectedHash = managedSite.hashes?.[file.path]
      if (currentHash && expectedHash && currentHash !== expectedHash)
        throw new Error(
          `Managed file changed outside this manager; review before editing: ${file.path}`
        )
      file.action = currentHash ? "update" : "create"
    }
    const htaccess = siteFiles.find((file) => file.path.endsWith(`/${domain}/.htaccess`))
    const htaccessPath = path.join(webroot, ".htaccess")
    if (!input.htaccess && exists(htaccessPath)) {
      if (fileHash(htaccessPath) !== managedSite.hashes?.[htaccessPath])
        throw new Error(
          `The .htaccess file has external changes; review it before removing: ${htaccessPath}`
        )
      if (htaccess) {
        htaccess.action = "remove"
        htaccess.content = ""
      } else
        siteFiles.push({
          path: htaccessPath,
          action: "remove",
          content: "",
          mode: 0o644,
          owner: account,
        })
    } else if (!input.htaccess && htaccess)
      siteFiles = siteFiles.filter((file) => file !== htaccess)
  }
  const pathConflicts = siteFiles.filter(
    (item) => !["update", "remove", "preserve"].includes(item.action) && exists(item.path)
  )
  if (pathConflicts.length)
    throw new Error(
      `Refusing to overwrite existing paths: ${pathConflicts.map((x) => x.path).join(", ")}`
    )
  const previewFiles = siteFiles.map((file) => {
    const before = readText(file.path) || ""
    const after = file.action === "symlink" ? `symlink -> ${file.target}` : file.content
    return {
      ...file,
      before,
      after,
      diff: unifiedDiff(file.path, before, after),
      hash: fileHash(file.path),
    }
  })
  const plan = {
    id: crypto.randomUUID(),
    kind: "site",
    domain,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    title: `${managedSite ? "Update" : "Create"} ${domain}`,
    confirmation: domain,
    summary: managedSite
      ? "Update the manager-owned Nginx/OLS site settings and security policy after reviewing each generated diff."
      : `Create the webroot, site account, Nginx/OLS configs, and private PHP configuration; enable only the ACME challenge vhost.${database.enabled ? ` Also create the ${database.engine} database and a localhost-only user.` : ""}`,
    database,
    settings: {
      domain,
      aliases: aliases.length ? aliases : [`www.${domain}`],
      webroot,
      account,
      owner: "dedicated",
      phpBinary,
      phpIni,
      phpIniProfile,
      ...phpSettings.settings,
      phpIniOverrides: phpSettings.advanced,
      listener,
      group,
      directoryMode,
      fileMode,
      directoryModeText,
      fileModeText,
      label: String(input.label || domain).slice(0, 120),
      notes: String(input.notes || "").slice(0, 2000),
      database: database.enabled
        ? { name: database.name, user: database.user, host: database.host }
        : null,
      placeholder: input.placeholder !== false,
      robots: input.robots || "allow",
      requestMode,
      upstream,
      firewallPorts,
      httpRedirect: input.httpRedirect !== false,
      nginxAccessLog: String(input.nginxAccessLog || ""),
      nginxErrorLog: String(input.nginxErrorLog || ""),
      certificatePath: cert,
      privateKeyPath: key,
      htaccess: Boolean(input.htaccess),
      update: Boolean(managedSite),
      ...security,
    },
    files: previewFiles,
    firewall: {
      ports: firewallPorts,
      addressFamilies: firewallChanged ? ["IPv4", "IPv6"] : [],
      previousPorts: oldFirewallPorts,
      rules: ["tcp", "udp"].flatMap((protocol) => [
        ...firewallPorts[protocol].map((port) => ({
          family: "IPv4 + IPv6",
          protocol,
          port,
          action: "allow from any source",
        })),
        ...(oldFirewallPorts[protocol] || [])
          .filter((port) => !firewallPorts[protocol].includes(port))
          .map((port) => ({
            family: "IPv4 + IPv6",
            protocol,
            port,
            action: "remove previous allow",
          })),
      ]),
    },
    directories: [
      { path: siteHome, action: "create", owner: "root", group: "root", mode: "0711" },
      ...(requestMode === "ols" && !exists(olsLogDir)
        ? [{ path: olsLogDir, action: "create", owner: "root", group: "nogroup", mode: "0750" }]
        : []),
      {
        path: webroot,
        action: managedSite ? "update permissions" : "create",
        owner: account,
        group,
        mode: directoryModeText,
      },
      ...(requestMode === "ols"
        ? [
            {
              path: path.join(siteHome, ".site-config"),
              action: managedSite ? "preserve" : "create",
              owner: account,
              group,
              mode: "0700",
            },
            {
              path: path.join(config.olsVhosts, domain),
              action: managedSite ? "update" : "create",
              owner: "lsadm",
              group: "nogroup",
              mode: "0750",
            },
          ]
        : []),
    ],
    warnings: [
      "The production TLS config remains available but disabled until both certificate files exist.",
      ...(!templates.deps.geoip
        ? ["GeoIP country blocking is omitted because no global block_country map is configured."]
        : []),
      ...(database.enabled
        ? [
            "Database creation requires the local MySQL/MariaDB server to accept root socket authentication.",
            "A random database password is shown once after apply; the manager does not store it. Database contents remain if the site operation is rolled back.",
          ]
        : []),
      ...(!templates.deps.badBot
        ? [
            "The eaglesvn template references $bad_bot, but no global map defines it; that optional rule is omitted.",
          ]
        : []),
      ...(!templates.deps.cacheZone
        ? [
            "The eaglesvn template references cache_zone, which is not defined globally; dependent proxy-cache rules are omitted.",
          ]
        : []),
      ...(!templates.deps.apiLimit
        ? [
            "The eaglesvn template references api_limit, which is not defined globally; the dependent rate-limit rule is omitted.",
          ]
        : []),
      ...(security.proxyCache && !templates.deps.cacheZone
        ? [
            "Shared proxy caching was requested, but cache_zone is not defined globally; proxy caching is omitted.",
          ]
        : []),
    ],
    fingerprints: Object.fromEntries(
      [config.olsMain, ...siteFiles.map((item) => item.path)].map((file) => [file, fileHash(file)])
    ),
    ...(firewallPorts.tcp.length || firewallPorts.udp.length
      ? [
          "Inbound firewall rules allow these host ports from any source over IPv4 and IPv6; container port publishing and upstream firewall rules are separate.",
        ]
      : []),
  }
  if (database.enabled)
    Object.defineProperty(plan, "databasePassword", {
      value: crypto.randomBytes(32).toString("base64url"),
      enumerable: false,
    })
  return plan
}

function togglePlan(config, input, manifest = {}) {
  const domain = validDomain(input.domain)
  const action = input.action
  if (!domain || !["enable", "disable"].includes(action))
    throw new Error("Choose a valid managed site and enable or disable action.")
  if (!manifest.sites?.[domain])
    throw new Error("Only manager-owned sites can be enabled or disabled.")
  const link = path.join(config.nginxEnabled, `${domain}_ssl.conf`)
  const target = path.join(config.nginxAvailable, "vhost_ssl", `${domain}_ssl.conf`)
  if (!exists(target)) throw new Error(`The renewal config is missing: ${target}`)
  const present = exists(link)
  if (present) {
    if (
      !fs.lstatSync(link).isSymbolicLink() ||
      path.resolve(path.dirname(link), fs.readlinkSync(link)) !== path.resolve(target)
    ) {
      throw new Error(`The enabled path is not the manager-owned renewal symlink: ${link}`)
    }
    if (action === "enable") throw new Error(`${domain} is already enabled.`)
  } else if (action === "disable") throw new Error(`${domain} is already disabled.`)
  const before = present ? `symlink -> ${fs.readlinkSync(link)}` : ""
  const after = action === "enable" ? `symlink -> ${target}` : ""
  return {
    id: crypto.randomUUID(),
    kind: "toggle",
    domain,
    action,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    title: `${action === "enable" ? "Enable" : "Disable"} ${domain}`,
    confirmation: `${action.toUpperCase()} ${domain}`,
    summary: `${action === "enable" ? "Create" : "Remove"} the manager-owned ACME renewal symlink and validate Nginx before reload.`,
    files: [
      {
        path: link,
        action: action === "enable" ? "symlink" : "remove",
        target,
        before,
        after,
        diff: unifiedDiff(link, before, after),
        hash: fileHash(link),
      },
    ],
    link,
    target,
    fingerprints: { [link]: fileHash(link), [target]: fileHash(target) },
    warnings: [],
  }
}

function adoptPlan(config, input, currentInventory, manifest = {}) {
  const domain = validDomain(input.domain)
  const site = currentInventory.sites.find((item) => item.domain === domain)
  if (!domain || !site) throw new Error("Choose a discovered website to adopt.")
  if (domain === "phpmyadmin")
    throw new Error("phpMyAdmin is protected and cannot be adopted for editing.")
  if (manifest.sites?.[domain]) throw new Error(`${domain} is already recorded by the manager.`)
  const paths = [
    ...site.nginxConfigs,
    ...site.olsVhosts.map((item) => item.path).filter(Boolean),
    ...currentInventory.nginx.links
      .filter((item) => item.path.includes(domain))
      .map((item) => item.path),
  ].filter(exists)
  if (!paths.length) throw new Error(`No configuration files were found for ${domain}.`)
  const hashes = Object.fromEntries([...new Set(paths)].map((file) => [file, fileHash(file)]))
  return {
    id: crypto.randomUUID(),
    kind: "adopt",
    domain,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    title: `Record ${domain} as discovered`,
    confirmation: `ADOPT ${domain}`,
    summary:
      "Record the current configuration paths and hashes without changing server files. Adopted sites stay read-only until converted to a manager template.",
    files: [...new Set(paths)].map((file) => ({
      path: file,
      action: "record",
      before: `sha256 ${hashes[file]}`,
      after: `sha256 ${hashes[file]}`,
      diff: "No server file changes. This path and its current hash will be recorded in manager state.",
    })),
    hashes,
    aliases: site.aliases,
    webroot: site.webroot || path.join(config.homeRoot, domain, "public_html"),
    previousSite: null,
    fingerprints: hashes,
    warnings: ["Adoption records inventory only; it does not rewrite or enable this site."],
  }
}

module.exports = {
  DEFAULT_CSP_POLICY,
  DEFAULTS,
  configFromEnv,
  readText,
  exists,
  listTree,
  fileHash,
  validDomain,
  accountForDomain,
  parseServerNames,
  parseOlsBlocks,
  scanNginx,
  scanOls,
  inventory,
  resetOlsConfig,
  unifiedDiff,
  depsInNginx,
  managerOptions,
  siteDetails,
  readMimeTypes,
  renderBoilerplate,
  renderFromEaglesvn,
  insertOlsVhost,
  renderOlsVhost,
  resetPlan,
  sitePlan,
  togglePlan,
  adoptPlan,
}
