const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const core = require("../../vhost-manager/server/core.cjs")
const ops = require("../../vhost-manager/server/operations.cjs")
const security = require("../../vhost-manager/server/security.cjs")

test("GeoIP country output parser accepts country editions and ignores unknown records", () => {
  assert.equal(security.parseGeoIpCountry("GeoIP Country Edition: EE, Estonia"), "EE")
  assert.equal(security.parseGeoIpCountry("GeoIP Country Edition: IN, India"), "IN")
  assert.equal(security.parseGeoIpCountry("GeoIP Country Edition: IP Address not found"), null)
  assert.equal(security.parseGeoIpCountry(""), null)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vhost-manager-"))
  const config = core.configFromEnv({
    VHOST_MANAGER_TEST_MODE: "1",
    VHOST_MANAGER_FIXTURE_ROOT: root,
  })
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const production = [
    "server {",
    " listen 80;",
    " server_name eaglesvn.club www.eaglesvn.club;",
    " location /.well-known/acme-challenge/ { root /home/eaglesvn.club/public_html/; allow all; }",
    " location / { return 301 https://$host$request_uri; }",
    "}",
    "server {",
    " listen 443 ssl http2;",
    " server_name eaglesvn.club www.eaglesvn.club;",
    " ssl_certificate /root/.acme.sh/eaglesvn.com_ecc/fullchain.cer;",
    " ssl_certificate_key /root/.acme.sh/eaglesvn.com_ecc/eaglesvn.club.key;",
    " # Security Headers",
    ' add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    " add_header X-Frame-Options SAMEORIGIN;",
    " add_header X-Content-Type-Options nosniff;",
    " if ($bad_bot = 1) { return 403; }",
    " # Main location block",
    " location {",
    " proxy_pass http://127.0.0.1:8088;",
    " proxy_cache_bypass $http_cache_control;",
    " proxy_no_cache $http_cache_control;",
    " }",
    "}",
    "",
  ]
    .join("\n")
    .replace(" location {", " location / {")
  const stage = [
    "server {",
    " listen 80;",
    " server_name eaglesvn.club www.eaglesvn.club;",
    " location /.well-known/acme-challenge/ { root /home/eaglesvn.club/public_html/; allow all; }",
    " location / { proxy_pass http://0.0.0.0:8088; }",
    " error_log /var/log/nginx/eaglesvn_club_error.log;",
    " access_log /var/log/nginx/eaglesvn_club_access.log;",
    "}",
    "",
  ].join("\n")
  put(path.join(config.nginxAvailable, "eaglesvn.club.conf"), production)
  put(path.join(config.nginxAvailable, "vhost_ssl/eaglesvn.club_ssl.conf"), stage)
  put(config.nginxMain, "http { include /etc/nginx/mime.types; }\n")
  put(config.mimeTypesFile, "types {\n text/html html htm;\n application/javascript js;\n}\n")
  fs.mkdirSync(config.nginxEnabled, { recursive: true })
  fs.symlinkSync("/missing/path.conf", path.join(config.nginxEnabled, "dangling.conf"))
  put(
    config.olsMain,
    [
      "virtualhost phpmyadmin {",
      "  configFile conf/vhosts/phpmyadmin/vhconf.conf",
      "}",
      "virtualhost staleSite {",
      "  configFile conf/vhosts/staleSite/vhconf.conf",
      "}",
      "listener Default {",
      "  address *:8088",
      "  map phpmyadmin phpmyadmin",
      "  map staleSite stale.example.test",
      "}",
      "listener PMA {",
      "  address *:9443",
      "  map phpmyadmin phpmyadmin",
      "}",
      "",
    ].join("\n")
  )
  put(path.join(config.olsVhosts, "phpmyadmin/vhconf.conf"), "vhDomain phpmyadmin\n")
  put(config.phpIni, "[PHP]\nmemory_limit=128M\n")
  return { root, config, put }
}

test("validates domain names and derives stable per-site accounts", () => {
  assert.equal(core.validDomain("Example.COM."), "example.com")
  assert.equal(core.validDomain("*.example.com"), null)
  assert.equal(core.validDomain("bad..example.com"), null)
  assert.equal(
    core.accountForDomain("example.com", new Date("2026-10-08T00:00:00Z")),
    "examcom1026"
  )
  assert.equal(
    core.accountForDomain("sub.example.com", new Date("2026-10-08T00:00:00Z")),
    "subeexample_com1026"
  )
  assert.equal(
    core.accountForDomain("eaglesvn.club", new Date("2026-10-08T00:00:00Z")),
    "eaglclub1026"
  )
  assert.throws(
    () => core.accountForDomain("a.example.abcdefghijklmnopqrstuvwxyz0123456789abcdef.com"),
    /32-character limit/
  )
})

test("global CSP includes the requested first-party and GPTMD vendors without unrelated vendors or broad script execution", () => {
  const policy = core.DEFAULT_CSP_POLICY
  for (const source of [
    "https://*.eagles.edu.vn",
    "https://*.gptpatient.com",
    "https://*.eaglesvn.club",
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.supabase.co",
    "https://api.openai.com",
    "https://merchantportal.acb.com.vn",
    "https://api.icepanel.io",
  ])
    assert.ok(policy.includes(source), `global CSP should include ${source}`)
  for (const unused of [
    "fonts.googleapis.com",
    "translate.googleapis.com",
    "brevo.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdn.ampproject.org",
    "youtube.com",
    "hcaptcha.com",
  ])
    assert.ok(!policy.includes(unused), `global CSP should not include unused vendor ${unused}`)
  assert.match(policy, /object-src 'none'/)
  assert.match(policy, /script-src[^;]*'sha256-/)
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-eval'/)
})

test("inventory groups aliases and reports broken Nginx symlinks", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.put(
    path.join(f.config.nginxAvailable, "sample.conf"),
    "server {\n server_name sample.example.test www.sample.example.test;\n}\n"
  )
  const result = core.inventory(f.config)
  const site = result.sites.find((item) => item.domain === "sample.example.test")
  assert.deepEqual(site.aliases, ["www.sample.example.test"])
  assert.equal(result.nginx.links.find((item) => item.path.endsWith("dangling.conf")).broken, true)
})

test("discovered OLS document roots populate the site inventory", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const webroot = `${path.join(f.root, "opt/phpmyadmin")}/`
  f.put(
    path.join(f.config.olsVhosts, "phpmyadmin/vhconf.conf"),
    `vhDomain phpmyadmin\ndocRoot ${webroot}\n`
  )
  const site = core.inventory(f.config).sites.find((item) => item.domain === "phpmyadmin")
  assert.equal(site.webroot, webroot)
})

test("renderer merges MIME mappings and emits configurable security and cache directives", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const rendered = core.renderFromEaglesvn(
    "sample.example.test",
    ["www.sample.example.test"],
    "/home/sample.example.test/public_html",
    "/root/.acme.sh/sample/fullchain.cer",
    "/root/.acme.sh/sample/sample.key",
    f.config,
    {
      cspMode: "report-only",
      cspPolicy:
        "default-src 'self'; object-src 'none'; img-src 'self' data: blob: https://cdn.example.test",
      mimeOverrides: ["application/wasm wasm"],
      staticCache: "30d",
    }
  )
  assert.match(rendered.production, /Content-Security-Policy-Report-Only/)
  assert.match(rendered.production, /application\/javascript js;/)
  assert.match(rendered.production, /application\/wasm wasm;/)
  assert.match(rendered.production, /expires 30d;/)
  assert.match(rendered.production, /location \/ \{\s+return 301 https:\/\/\$host\$request_uri;/)
  assert.match(rendered.production, /location \/ \{\s+proxy_pass http:\/\/127\.0\.0\.1:8088;/)
  assert.equal((rendered.production.match(/add_header X-Frame-Options/g) || []).length, 1)
  assert.equal((rendered.production.match(/add_header X-Content-Type-Options/g) || []).length, 1)
  assert.doesNotMatch(rendered.production, /proxy_cache\s+cache_zone/)
  assert.doesNotMatch(rendered.production, /proxy_no_cache|limit_req_status/)
  assert.doesNotMatch(rendered.stage, /0\.0\.0\.0/)
})

test("accepts pasted aliases and detects collisions with the default www alias", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.put(
    path.join(f.config.nginxAvailable, "www.sample.example.test.conf"),
    "server {\n server_name www.sample.example.test;\n}\n"
  )
  assert.throws(
    () =>
      core.sitePlan(
        f.config,
        { domain: "sample.example.test", aliases: "" },
        core.inventory(f.config)
      ),
    /already uses www\.sample\.example\.test/
  )
  const plan = core.sitePlan(
    f.config,
    { domain: "other.example.test", aliases: "www.other.example.test, assets.other.example.test" },
    core.inventory(f.config)
  )
  assert.deepEqual(plan.settings.aliases, ["www.other.example.test", "assets.other.example.test"])
})

test("reset preview and apply preserve phpMyAdmin paths and nonempty directories", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.put(
    path.join(f.config.nginxAvailable, "site.conf"),
    "server { server_name stale.example.test; }\n"
  )
  f.put(
    path.join(f.config.nginxAvailable, "vhost_ssl/phpmyadmin_ssl.conf"),
    "server { server_name phpmyadmin; }\n"
  )
  f.put(
    path.join(f.config.nginxAvailable, "vhost_ssl/stale_ssl.conf"),
    "server { server_name stale.example.test; }\n"
  )
  f.put(path.join(f.config.olsVhosts, "phpmyadmin/credentials.txt"), "keep")
  const plan = core.resetPlan(f.config)
  assert.equal(
    plan.files.some((item) => item.path.includes("phpmyadmin")),
    false
  )
  assert.equal(
    plan.warnings.some((item) => item.includes("staleSite")),
    true
  )
  const archived = ops.archiveExamples(plan, f.config)
  assert.equal(archived.archivePath, plan.archivePath)
  assert.equal(fs.existsSync(path.join(f.config.nginxAvailable, "site.conf")), true)
  assert.equal(archived.filesArchived > 0, true)
  const result = ops.applyPlan(plan, f.config)
  assert.equal(result.checks.nginx.ok, true)
  assert.equal(result.operation.backup, plan.archivePath)
  assert.equal(fs.existsSync(path.join(plan.archivePath, "snapshot.json")), true)
  assert.equal(
    fs.readFileSync(
      path.join(plan.archivePath, "rootfs", f.config.nginxAvailable.slice(1), "site.conf"),
      "utf8"
    ),
    "server { server_name stale.example.test; }\n"
  )
  assert.equal(fs.existsSync(path.join(f.config.olsVhosts, "phpmyadmin/vhconf.conf")), true)
  assert.equal(
    fs.readFileSync(path.join(f.config.olsVhosts, "phpmyadmin/credentials.txt"), "utf8"),
    "keep"
  )
  assert.equal(
    fs.existsSync(path.join(f.config.nginxAvailable, "vhost_ssl/phpmyadmin_ssl.conf")),
    true
  )
  ops.rollbackOperation(result.operation.id, f.config)
  assert.equal(fs.existsSync(path.join(f.config.nginxAvailable, "site.conf")), true)
})

test("site preview and rollback use fixture paths and preserve reviewed file content", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const originalV4 = [
    "*raw",
    ":PREROUTING ACCEPT [0:0]",
    "-A PREROUTING -d 127.0.0.1/32 ! -i lo -p tcp --dport 5432 -j DROP",
    "COMMIT",
    "*filter",
    ":INPUT ACCEPT [0:0]",
    ":FORWARD DROP [0:0]",
    ":OUTPUT ACCEPT [0:0]",
    ":SSHWATCH - [0:0]",
    "-A INPUT -j SSHWATCH",
    "-A INPUT -s 192.0.2.10/32 -p tcp --dport 443 -j ACCEPT",
    "-A SSHWATCH -s 198.51.100.2/32 -p tcp --dport 24700 -j DROP",
    "COMMIT",
    "*nat",
    ":PREROUTING ACCEPT [0:0]",
    "COMMIT",
    "",
  ].join("\n")
  const originalV6 = [
    "*filter",
    ":INPUT ACCEPT [0:0]",
    ":FORWARD ACCEPT [0:0]",
    ":OUTPUT ACCEPT [0:0]",
    "-A FORWARD -j DOCKER-USER",
    "COMMIT",
    "*nat",
    ":PREROUTING ACCEPT [0:0]",
    "COMMIT",
    "",
  ].join("\n")
  f.put(f.config.iptablesRulesV4, originalV4)
  f.put(f.config.iptablesRulesV6, originalV6)
  const plan = core.sitePlan(
    f.config,
    {
      domain: "new.example.test",
      tcpPorts: "8080, 8443",
      udpPorts: "51820",
      mimeOverrides: ["application/wasm wasm"],
      phpMemoryLimit: "512M",
      phpUploadMaxFilesize: "64M",
      phpIniOverrides: "opcache.memory_consumption = 192\nsession.cookie_httponly = 1",
    },
    core.inventory(f.config)
  )
  assert.equal(plan.settings.webroot, path.join(f.config.homeRoot, "new.example.test/public_html"))
  assert.equal(plan.settings.cspSource, "global")
  assert.deepEqual(plan.settings.firewallPorts, { tcp: [8080, 8443], udp: [51820] })
  assert.equal(plan.firewall.addressFamilies.join(", "), "IPv4, IPv6")
  assert.equal(plan.firewall.rules.length, 3)
  for (const rulesPath of [f.config.iptablesRulesV4, f.config.iptablesRulesV6]) {
    const change = plan.files.find((item) => item.path === rulesPath)
    assert.ok(change, `review should include ${rulesPath}`)
    assert.match(change.after, /:VHOST-MANAGER - \[0:0\]/)
    assert.match(change.after, /-A INPUT -j VHOST-MANAGER/)
    assert.match(change.after, /--dport 8080 .*--comment vhm_new_example_test_tcp -j ACCEPT/)
    assert.match(change.after, /--dport 51820 .*--comment vhm_new_example_test_udp -j ACCEPT/)
  }
  assert.match(
    plan.files.find((item) => item.path === f.config.iptablesRulesV4).after,
    /\*raw[\s\S]*--dport 5432 -j DROP/
  )
  assert.match(
    plan.files.find((item) => item.path === f.config.iptablesRulesV4).after,
    /\*nat[\s\S]*COMMIT/
  )
  assert.match(
    plan.files.find((item) => item.path === f.config.iptablesRulesV6).after,
    /-A FORWARD -j DOCKER-USER/
  )
  assert.match(plan.settings.cspPolicy, /default-src 'self'/)
  assert.match(plan.settings.cspPolicy, /worker-src 'self' blob:/)
  assert.match(
    plan.files.find((item) => item.path.endsWith("new.example.test.conf")).after,
    /server_name new\.example\.test www\.new\.example\.test;/
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith("vhconf.conf")).after,
    /vhDomain new\.example\.test\n/
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith(".site-config/php.ini")).after,
    /memory_limit=128M/
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith(".site-config/php.ini")).after,
    /memory_limit = 512M/
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith(".site-config/php.ini")).after,
    /opcache\.memory_consumption = 192/
  )
  assert.equal(plan.settings.phpMemoryLimit, "512M")
  assert.equal(
    plan.settings.phpIniOverrides,
    "opcache.memory_consumption = 192\nsession.cookie_httponly = 1"
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith("index.html")).after,
    /<title>new\.example\.test<\/title>/
  )
  assert.equal(
    plan.files.some((item) => /{{[A-Z0-9_]+}}/.test(item.after)),
    false
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith("new.example.test.conf")).after,
    /application\/wasm wasm/
  )
  const result = ops.applyPlan(plan, f.config)
  assert.equal(
    fs.existsSync(path.join(f.config.homeRoot, "new.example.test/public_html/index.html")),
    true
  )
  assert.match(fs.readFileSync(f.config.iptablesRulesV4, "utf8"), /--dport 8080/)
  assert.match(fs.readFileSync(f.config.iptablesRulesV6, "utf8"), /--dport 51820/)
  ops.rollbackOperation(result.operation.id, f.config)
  assert.equal(
    fs.existsSync(path.join(f.config.homeRoot, "new.example.test/public_html/index.html")),
    false
  )
  assert.equal(fs.readFileSync(f.config.iptablesRulesV4, "utf8"), originalV4)
  assert.equal(fs.readFileSync(f.config.iptablesRulesV6, "utf8"), originalV6)
})

test("site planning rejects invalid inbound firewall ports", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  for (const value of ["0", "65536", "abc", "80; -j DROP"]) {
    assert.throws(
      () =>
        core.sitePlan(
          f.config,
          { domain: "ports.example.test", tcpPorts: value },
          core.inventory(f.config)
        ),
      /TCP inbound ports/
    )
  }
})

test("managed site edits retain the dedicated account originally assigned", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const account = "examexample_com0926"
  const plan = core.sitePlan(
    f.config,
    { domain: "example.com", owner: "dedicated" },
    core.inventory(f.config),
    { sites: { "example.com": { settings: { account, requestMode: "ols" }, hashes: {} } } }
  )
  assert.equal(plan.settings.account, account)
  assert.equal(plan.settings.group, account)
})

test("PHP profile values are parsed for prefilled form controls", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.put(
    f.config.phpIni,
    "[PHP]\nmemory_limit = 128M\ndisplay_errors = Off\ndate.timezone = Asia/Ho_Chi_Minh\n"
  )
  const options = core.managerOptions(f.config)
  assert.deepEqual(options.phpIniValues[f.config.phpIni], {
    phpMemoryLimit: "128M",
    phpDateTimezone: "Asia/Ho_Chi_Minh",
    phpDisplayErrors: "Off",
  })
})

test("robots and OLS rewrite files render from the selected boilerplates", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const plan = core.sitePlan(
    f.config,
    { domain: "boilerplate.example.test", robots: "block", htaccess: true },
    core.inventory(f.config)
  )
  assert.equal(
    plan.files.find((item) => item.path.endsWith("/robots.txt")).after,
    "User-agent: *\nDisallow: /\n"
  )
  assert.match(
    plan.files.find((item) => item.path.endsWith("/.htaccess")).after,
    /OpenLiteSpeed rewrite rules for boilerplate\.example\.test/
  )
  assert.match(
    plan.files.find((item) => item.path === f.config.olsMain).after,
    /virtualhost boilerplate\.example\.test \{/
  )
})

test("managed site edits preview changed security policy and rollback to the previous configuration", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const initial = core.sitePlan(f.config, { domain: "edit.example.test" }, core.inventory(f.config))
  ops.applyPlan(initial, f.config)
  const manifest = ops.readManifest(f.config)
  const current = core.inventory(f.config, manifest)
  assert.equal(current.sites.find((site) => site.domain === "edit.example.test").drifted, false)
  const edited = core.sitePlan(
    f.config,
    {
      domain: "edit.example.test",
      aliases: ["www.edit.example.test"],
      cspSource: "custom",
      cspMode: "enforce",
      cspPolicy:
        "default-src 'self'; object-src 'none'; img-src 'self' data: blob: https://cdn.example.test",
      staticCache: "5m",
    },
    current,
    manifest
  )
  assert.match(edited.title, /^Update /)
  assert.equal(edited.settings.cspSource, "custom")
  assert.match(
    edited.files.find((file) => file.path.endsWith("edit.example.test.conf")).after,
    /Content-Security-Policy "default-src 'self'; object-src 'none'; img-src 'self' data: blob: https:\/\/cdn\.example\.test/
  )
  const applied = ops.applyPlan(edited, f.config)
  assert.equal(
    core
      .inventory(f.config, ops.readManifest(f.config))
      .sites.find((site) => site.domain === "edit.example.test").drifted,
    false
  )
  ops.rollbackOperation(applied.operation.id, f.config)
  assert.match(
    fs.readFileSync(path.join(f.config.nginxAvailable, "edit.example.test.conf"), "utf8"),
    /Content-Security-Policy-Report-Only/
  )
})

test("managed routing conversion removes the OLS mapping in the reviewed plan", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const created = core.sitePlan(
    f.config,
    { domain: "route.example.test" },
    core.inventory(f.config)
  )
  ops.applyPlan(created, f.config)
  const manifest = ops.readManifest(f.config)
  const current = core.inventory(f.config, manifest)
  const converted = core.sitePlan(
    f.config,
    {
      ...manifest.sites["route.example.test"].settings,
      domain: "route.example.test",
      requestMode: "static",
    },
    current,
    manifest
  )
  assert.equal(
    converted.files.some((file) => file.action === "remove" && file.path.endsWith("vhconf.conf")),
    true
  )
  assert.equal(
    converted.files
      .find((file) => file.path === f.config.olsMain)
      .after.includes("virtualhost route.example.test"),
    false
  )
})

test("routing, log paths, and OLS-only rewrite fields are validated and rendered", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  assert.throws(
    () =>
      core.sitePlan(
        f.config,
        { domain: "proxy.example.test", requestMode: "proxy", upstream: "192.168.1.20:8080" },
        core.inventory(f.config)
      ),
    /must use loopback/
  )
  assert.throws(
    () =>
      core.sitePlan(
        f.config,
        { domain: "static.example.test", requestMode: "static", htaccess: true },
        core.inventory(f.config)
      ),
    /.htaccess template applies only/
  )
  const plan = core.sitePlan(
    f.config,
    {
      domain: "proxy.example.test",
      requestMode: "proxy",
      upstream: "127.0.0.1:9000",
      nginxAccessLog: "/var/log/nginx/proxy_access.log",
      nginxErrorLog: "/var/log/nginx/proxy_error.log",
    },
    core.inventory(f.config)
  )
  assert.match(
    plan.files.find((file) => file.path.endsWith("proxy.example.test.conf")).after,
    /proxy_pass http:\/\/127\.0\.0\.1:9000;/
  )
  assert.match(
    plan.files.find((file) => file.path.endsWith("proxy.example.test.conf")).after,
    /access_log \/var\/log\/nginx\/proxy_access\.log/
  )
})

test("enable and disable plans review the renewal symlink and rollback cleanly", (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const site = core.sitePlan(f.config, { domain: "toggle.example.test" }, core.inventory(f.config))
  ops.applyPlan(site, f.config)
  let manifest = ops.readManifest(f.config)
  const disabled = core.togglePlan(
    f.config,
    { domain: "toggle.example.test", action: "disable" },
    manifest
  )
  assert.equal(disabled.files[0].action, "remove")
  const stopped = ops.applyPlan(disabled, f.config)
  assert.equal(fs.existsSync(disabled.link), false)
  manifest = ops.readManifest(f.config)
  const enabled = core.togglePlan(
    f.config,
    { domain: "toggle.example.test", action: "enable" },
    manifest
  )
  assert.equal(enabled.files[0].action, "symlink")
  const started = ops.applyPlan(enabled, f.config)
  assert.equal(fs.lstatSync(disabled.link).isSymbolicLink(), true)
  ops.rollbackOperation(started.operation.id, f.config)
  assert.equal(fs.existsSync(disabled.link), false)
  assert.equal(stopped.operation.state, "applied")
})
