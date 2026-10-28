const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const script = path.resolve(__dirname, "../../vhost-manager/ops/lsws-config-guard.sh")
const validConfig =
  "user nobody\ngroup nogroup\nerrorlog logs/error.log {\n}\nlistener Default {\n}\n"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsws-config-guard-"))
  const config = path.join(root, "httpd_config.conf")
  const backup = path.join(root, "known-good.conf")
  const archive = path.join(root, "archive")
  const binary = path.join(root, "openlitespeed-test")
  fs.writeFileSync(
    binary,
    `#!/bin/sh\ngrep -Eiq '^[[:space:]]*errorlog[[:space:]]+' "$TEST_CONFIG" && grep -Eiq '^[[:space:]]*listener[[:space:]]+' "$TEST_CONFIG"\n`
  )
  fs.chmodSync(binary, 0o755)
  return { root, config, backup, archive, binary }
}

function runGuard(paths) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      LSWS_GUARD_CONFIG: paths.config,
      LSWS_GUARD_BACKUP: paths.backup,
      LSWS_GUARD_ARCHIVE_DIR: paths.archive,
      LSWS_GUARD_BINARY: paths.binary,
      TEST_CONFIG: paths.config,
    },
  })
}

test("snapshots the active config only after validation", (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))
  fs.writeFileSync(paths.config, validConfig)

  const result = runGuard(paths)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(paths.backup, "utf8"), validConfig)
})

test("preserves invalid config and restores the last validated snapshot", (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))
  fs.writeFileSync(paths.backup, validConfig)
  fs.writeFileSync(paths.config, "")

  const result = runGuard(paths)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(paths.config, "utf8"), validConfig)
  assert.equal(fs.readdirSync(paths.archive).length, 1)
})

test("fails closed when config is invalid and no known-good snapshot exists", (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))
  fs.writeFileSync(paths.config, "")

  const result = runGuard(paths)

  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(paths.config, "utf8"), "")
  assert.equal(fs.existsSync(paths.backup), false)
})
