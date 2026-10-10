const { spawnSync } = require("node:child_process")
const readline = require("node:readline")
const { stdin, stdout } = require("node:process")

const VERSION_PATTERN = /ACME_(?:DEV_)?BETA_(\d+)\.(\d+)\.(\d+)\.(\d+)/i

function runGit(args, { capture = false } = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.status}`)
  }

  return result.stdout?.trim() ?? ""
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  }
}

function formatVersion(parts) {
  return parts
    .map((part, index) => {
      const width = index === 3 || (index === 2 && part > 0) ? 2 : 1
      return String(part).padStart(width, "0")
    })
    .join(".")
}

function nextVersion(commits) {
  for (const subject of commits.split("\n")) {
    const match = subject.match(VERSION_PATTERN)
    if (!match) continue

    const parts = match.slice(1).map(Number)
    const last = parts.length - 1
    if (parts[last] < 99) {
      parts[last] += 1
    } else {
      parts[last] = 0
      parts[last - 1] += 1
    }

    return formatVersion(parts)
  }

  return "0.0.0.01"
}

function promptWithPrefill(suggestedMessage) {
  return new Promise((resolve, reject) => {
    const prompt = readline.createInterface({ input: stdin, output: stdout })

    prompt.once("SIGINT", () => {
      prompt.close()
      reject(new Error("Commit cancelled."))
    })

    prompt.question(
      "Commit message (edit the version or add ' - description'; Enter accepts; shell commands run before this prompt): ",
      (answer) => {
        const message = answer.trim() || suggestedMessage
        const prefix = suggestedMessage.replace(/\d+(?:\.\d+){3}$/, "")
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const allowedMessage = new RegExp(`^${escapedPrefix}\\d+(?:\\.\\d+){3}(?: - .+)?$`)

        prompt.close()
        if (!allowedMessage.test(message)) {
          reject(
            new Error(
              `Invalid commit message. Use '${suggestedMessage}' or the same prefix with a four-part version, optionally followed by ' - description'. Run shell commands before starting git:update.`
            )
          )
          return
        }

        resolve(message)
      }
    )
    prompt.write(suggestedMessage)
  })
}

function confirmPublish(message) {
  return new Promise((resolve) => {
    const prompt = readline.createInterface({ input: stdin, output: stdout })
    prompt.question(
      `\nCommit message: ${message}\nThis will run npm run check, stage all changes, commit, and push to origin. Continue? [y/N] `,
      (answer) => {
        prompt.close()
        resolve(/^(y|yes)$/i.test(answer.trim()))
      }
    )
  })
}

async function main() {
  const commits = runGit(["log", "--format=%s"], { capture: true })
  const suggestedMessage = `ACME_DEV_BETA_${nextVersion(commits)}`

  if (process.argv.includes("--dry-run")) {
    stdout.write(`${suggestedMessage}\n`)
    return
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Run npm run git:update from an interactive terminal.")
  }

  const message = await promptWithPrefill(suggestedMessage)
  if (!(await confirmPublish(message))) {
    stdout.write("Cancelled; no checks or Git changes were made.\n")
    return
  }

  runCommand("npm", ["run", "check"])
  runGit(["add", "."])
  runGit(["commit", "-m", message])
  runGit(["push"])
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
