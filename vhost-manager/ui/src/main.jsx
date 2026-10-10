import React, { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { createRoot } from "react-dom/client"
import starterPolicy from "../../shared/csp-policy.txt?raw"
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileCode2,
  Globe2,
  LayoutDashboard,
  ListFilter,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react"
import "./styles.css"

const textScaleStops = [1.25, 1.5, 1.75, 2, 2.25]
const textScaleKey = "vhost-manager-text-scale"
const textScaleManualKey = "vhost-manager-text-scale-manual"

function isUhdDisplay() {
  const pixelRatio = window.devicePixelRatio || 1
  const physicalWidth = Math.max(window.screen.width, window.screen.height) * pixelRatio
  const physicalHeight = Math.min(window.screen.width, window.screen.height) * pixelRatio
  return physicalWidth >= 3840 && physicalHeight >= 2160
}

function recommendedTextScale(isUhd) {
  return isUhd ? 2 : 1.75
}

function phpFormValues(options, profile) {
  const values = options.phpIniValues?.[profile] || {}
  return {
    phpMemoryLimit: values.phpMemoryLimit || "",
    phpUploadMaxFilesize: values.phpUploadMaxFilesize || "",
    phpPostMaxSize: values.phpPostMaxSize || "",
    phpMaxExecutionTime: values.phpMaxExecutionTime || "",
    phpMaxInputTime: values.phpMaxInputTime || "",
    phpMaxInputVars: values.phpMaxInputVars || "",
    phpDateTimezone: values.phpDateTimezone || "",
    phpDisplayErrors: values.phpDisplayErrors
      ? /^(?:1|on|yes)$/i.test(values.phpDisplayErrors)
        ? "1"
        : "0"
      : "",
    phpLogErrors: values.phpLogErrors
      ? /^(?:1|on|yes)$/i.test(values.phpLogErrors)
        ? "1"
        : "0"
      : "",
  }
}

function formDefaults(domain = "", options = {}, phpIni = options.phpIniProfiles?.[0] || "") {
  const stem = domain.toLowerCase().replace(/[^a-z0-9]+/g, "_")
  const acmeHome = options.paths?.acmeHome || "/root/.acme.sh"
  return {
    domain,
    aliases: "",
    label: "",
    notes: "",
    createDatabase: false,
    databaseName: stem.slice(0, 64),
    databaseUser: `site_${stem}`.slice(0, 32),
    webroot: domain ? `${options.paths?.homeRoot || "/home"}/${domain}/public_html/` : "",
    owner: "dedicated",
    group: "dedicated",
    directoryMode: "0755",
    fileMode: "0644",
    placeholder: true,
    robots: "allow",
    requestMode: "ols",
    upstream: "127.0.0.1:8088",
    tcpPorts: "80, 443",
    udpPorts: "",
    htaccess: false,
    httpRedirect: true,
    nginxAccessLog: stem ? `/var/log/nginx/${stem}_access.log` : "",
    nginxErrorLog: stem ? `/var/log/nginx/${stem}_error.log` : "",
    certificatePath: domain ? `${acmeHome}/${domain}_ecc/fullchain.cer` : "",
    privateKeyPath: domain ? `${acmeHome}/${domain}_ecc/${domain}.key` : "",
    olsListener: "Default",
    phpBinary: options.phpHandlers?.[0] || "",
    phpIni,
    ...phpFormValues(options, phpIni),
    phpIniOverrides: "",
    cspSource: "global",
    cspMode: "report-only",
    cspPolicy: options.globalCspPolicy || starterPolicy,
    hsts: true,
    frameOptions: "SAMEORIGIN",
    referrerPolicy: "strict-origin",
    permissionsPolicy: "geolocation=(), microphone=(), camera=()",
    mimeOverrides: "",
    staticCache: "1h",
    proxyCache: false,
  }
}

function App() {
  const [theme, setTheme] = useState(() =>
    window.localStorage.getItem("vhost-manager-theme") === "light" ? "light" : "dark"
  )
  const [isUhd, setIsUhd] = useState(isUhdDisplay)
  const [textScale, setTextScale] = useState(() => {
    const savedScale = Number(window.localStorage.getItem(textScaleKey))
    const manualChoice = window.localStorage.getItem(textScaleManualKey) === "true"
    return manualChoice && textScaleStops.includes(savedScale)
      ? savedScale
      : recommendedTextScale(isUhdDisplay())
  })
  const [csrf, setCsrf] = useState("")
  const [status, setStatus] = useState(null)
  const [security, setSecurity] = useState(null)
  const [filter, setFilter] = useState("All sites")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState("")
  const [modal, setModal] = useState("")
  const [form, setForm] = useState(formDefaults())
  const [editing, setEditing] = useState(false)
  const [plan, setPlan] = useState(null)
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [mobileNav, setMobileNav] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [siteDetails, setSiteDetails] = useState(null)
  const [databaseCredentials, setDatabaseCredentials] = useState(null)
  const [sslJob, setSslJob] = useState(null)
  const [sslResponse, setSslResponse] = useState("")
  const createHostRef = useRef(null)
  const sslOutputRef = useRef(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem("vhost-manager-theme", theme)
  }, [theme])
  useEffect(() => {
    const updateDisplayProfile = () => setIsUhd(isUhdDisplay())
    window.addEventListener("resize", updateDisplayProfile)
    return () => window.removeEventListener("resize", updateDisplayProfile)
  }, [])
  useEffect(() => {
    if (window.localStorage.getItem(textScaleManualKey) !== "true")
      setTextScale(recommendedTextScale(isUhd))
  }, [isUhd])
  useEffect(() => {
    document.documentElement.style.setProperty("--text-scale", textScale)
    window.localStorage.setItem(textScaleKey, String(textScale))
  }, [textScale])
  useEffect(() => {
    if (modal === "create")
      createHostRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [modal])
  useEffect(() => {
    const output = sslOutputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [sslJob?.output])

  function adjustTextScale(direction) {
    window.localStorage.setItem(textScaleManualKey, "true")
    setTextScale((current) => {
      const currentIndex = textScaleStops.indexOf(current)
      const nextIndex = Math.max(0, Math.min(textScaleStops.length - 1, currentIndex + direction))
      return textScaleStops[nextIndex]
    })
  }

  async function request(path, payload) {
    const response = await fetch(
      `/api/${path}`,
      payload
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
            body: JSON.stringify(payload),
          }
        : {}
    )
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
    return data
  }

  async function refresh() {
    try {
      const result = await request("status")
      setStatus(result)
      setSelected((value) =>
        value && result.inventory.sites.some((site) => site.domain === value) ? value : ""
      )
    } catch (error) {
      setMessage(error.message)
    }
  }

  async function controlRuntime(action) {
    if (
      action === "logoff" &&
      !window.confirm(
        "Log off and stop the Vhost Manager runtime? You can start it again from its launcher."
      )
    )
      return
    setBusy(true)
    setMessage(action === "restart" ? "Restarting Vhost Manager…" : "Logging off Vhost Manager…")
    try {
      const result = await request("runtime", { action })
      setMessage(result.message)
      if (action === "restart") {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500))
          try {
            const response = await fetch("/api/status", { cache: "no-store" })
            if (response.ok) {
              window.location.reload()
              return
            }
          } catch {
            // The service is between shutdown and startup; keep polling.
          }
        }
        setMessage(
          "Restart was requested, but the manager has not reconnected yet. Check its service status."
        )
      }
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    fetch("/api/session")
      .then((res) => res.json())
      .then((data) => setCsrf(data.csrf))
      .catch(() => setMessage("Unable to connect to the local manager."))
  }, [])
  useEffect(() => {
    fetch("/api/ssl-job")
      .then((res) => res.json())
      .then(({ job }) => {
        if (job?.status === "running") {
          setSslJob(job)
          setModal("ssl-renewal")
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (csrf) refresh()
  }, [csrf])
  useEffect(() => {
    if (modal !== "ssl-renewal" || sslJob?.status !== "running" || !sslJob.id) return undefined
    let current = true
    const poll = async () => {
      try {
        const response = await fetch(`/api/ssl-job?id=${encodeURIComponent(sslJob.id)}`, {
          cache: "no-store",
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || "Unable to read SSL renewal output.")
        if (current && data.job) {
          setSslJob(data.job)
          if (data.job.status !== "running") refresh()
        }
      } catch (error) {
        if (current) setMessage(error.message)
      }
    }
    poll()
    const timer = window.setInterval(poll, 900)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [modal, sslJob?.id, sslJob?.status])
  useEffect(() => {
    if (!csrf) return undefined
    let current = true
    async function refreshSecurity() {
      try {
        const snapshot = await request("security")
        if (current) setSecurity(snapshot)
      } catch (error) {
        if (current) setSecurity({ error: error.message })
      }
    }
    refreshSecurity()
    const timer = window.setInterval(refreshSecurity, 60_000)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [csrf])
  useEffect(() => {
    const profile = status?.options?.phpIniProfiles?.[0]
    if (modal !== "create" || editing || form.phpIni || !profile) return
    const profileValues = phpFormValues(status.options, profile)
    setForm((previous) => ({
      ...previous,
      phpIni: profile,
      ...Object.fromEntries(
        Object.entries(profileValues).map(([key, value]) => [key, previous[key] || value])
      ),
    }))
  }, [status, modal, editing, form.phpIni])

  const sites = status?.inventory.sites || []
  const visibleSites = useMemo(
    () =>
      sites.filter((site) => {
        const matchesSearch = `${site.domain} ${site.aliases.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase())
        const matchesFilter =
          filter === "All sites" ||
          (filter === "Enabled" && site.enabled) ||
          (filter === "Needs review" && (site.drifted || site.status === "invalid")) ||
          (filter === "Invalid" && site.status === "invalid") ||
          (filter === "Managed" && site.managed) ||
          (filter === "Discovered" && !site.managed) ||
          (filter === "Pending TLS" && !site.tlsReady)
        return matchesSearch && matchesFilter
      }),
    [sites, search, filter]
  )
  const current = sites.find((site) => site.domain === selected)
  const services = status?.services
  const upCount = Number(Boolean(services?.nginx.active)) + Number(Boolean(services?.ols.active))

  function openCreate() {
    setEditing(false)
    setPlan(null)
    setConfirmation("")
    setMessage("")
    setForm(formDefaults("", status?.options))
    setModal("create")
    setMobileNav(false)
  }

  function changeDomain(domain) {
    const normalized = domain.trim().toLowerCase()
    const stem = normalized.replace(/[^a-z0-9]+/g, "_")
    const acmeHome = status?.options?.paths?.acmeHome || "/root/.acme.sh"
    setForm((previous) => ({
      ...previous,
      domain,
      webroot: normalized
        ? `${status?.options?.paths?.homeRoot || "/home"}/${normalized}/public_html/`
        : "",
      nginxAccessLog: stem ? `/var/log/nginx/${stem}_access.log` : "",
      nginxErrorLog: stem ? `/var/log/nginx/${stem}_error.log` : "",
      databaseName: normalized
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .slice(0, 64),
      databaseUser: `site_${stem}`.slice(0, 32),
      certificatePath: normalized ? `${acmeHome}/${normalized}_ecc/fullchain.cer` : "",
      privateKeyPath: normalized ? `${acmeHome}/${normalized}_ecc/${normalized}.key` : "",
    }))
  }

  function openEdit() {
    if (!current?.managed || current.adoptedReadOnly) return
    const saved = current.managerSettings || {}
    setEditing(true)
    setPlan(null)
    setConfirmation("")
    setMessage("")
    setForm({
      ...formDefaults(
        current.domain,
        status?.options,
        saved.phpIni || status?.options?.phpIniProfiles?.[0]
      ),
      ...saved,
      domain: current.domain,
      owner: "dedicated",
      group: "dedicated",
      cspSource: saved.cspSource || (saved.cspPolicy ? "custom" : "global"),
      directoryMode:
        saved.directoryModeText || saved.directoryMode?.toString(8).padStart(4, "0") || "0755",
      fileMode: saved.fileModeText || saved.fileMode?.toString(8).padStart(4, "0") || "0644",
      aliases: (saved.aliases || current.aliases || []).join(", "),
      tcpPorts: (saved.firewallPorts?.tcp || []).join(", "),
      udpPorts: (saved.firewallPorts?.udp || []).join(", "),
      mimeOverrides: (saved.mimeOverrides || []).join("\n"),
      hsts: saved.hsts !== false,
      proxyCache: Boolean(saved.proxyCache),
    })
    setModal("create")
  }

  async function previewSite(event) {
    event.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const result = await request("plan/site", {
        ...form,
        aliases: form.aliases.split(/[\s,]+/).filter(Boolean),
      })
      setPlan(result.plan)
      setModal("review")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function previewReset() {
    setBusy(true)
    setMessage("")
    try {
      const result = await request("plan/reset", {})
      setPlan(result.plan)
      setConfirmation("")
      setModal("review")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function archiveCurrentExamples() {
    if (!plan || plan.kind !== "reset" || plan.archivedAt) return
    setBusy(true)
    setMessage("")
    try {
      const result = await request("archive/examples", { planId: plan.id })
      setPlan((currentPlan) => ({
        ...currentPlan,
        archivedAt: result.operation.at,
        archivePath: result.archivePath,
      }))
      await refresh()
      setMessage(
        `${result.filesArchived} example config paths saved to ${result.archivePath}. Active configs were not changed.`
      )
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function previewToggle(action) {
    if (!current?.managed) return
    setBusy(true)
    setMessage("")
    try {
      const result = await request("plan/toggle", { domain: current.domain, action })
      setPlan(result.plan)
      setConfirmation("")
      setModal("review")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    setBusy(true)
    setMessage("")
    try {
      const result = await request("apply", { planId: plan.id, confirmation })
      setSelected(plan.domain || "")
      setDatabaseCredentials(result.databaseCredentials || null)
      setModal(result.databaseCredentials ? "database-credentials" : "")
      setPlan(null)
      setConfirmation("")
      await refresh()
      setMessage(
        plan.kind === "adopt"
          ? "Configuration recorded; server files were unchanged."
          : "Changes applied and both services validated."
      )
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function rollback(operationId) {
    if (!window.confirm("Roll back this operation from its root-only backup?")) return
    setBusy(true)
    try {
      await request("rollback", { operationId })
      await refresh()
      setMessage("Rollback completed and service checks passed.")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function scan() {
    setBusy(true)
    try {
      const result = await request("scan", {})
      setStatus((s) => ({ ...s, ...result }))
      setMessage("Inventory refreshed.")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function validateConfigs() {
    setBusy(true)
    setMessage("")
    try {
      const result = await request("validate", {})
      setStatus((currentStatus) => ({ ...currentStatus, services: result.services }))
      const checks = ["nginx", "ols"].map(
        (name) =>
          `${name === "ols" ? "OLS" : "Nginx"}: ${result.services[name].configValid ? "valid" : result.services[name].detail}`
      )
      setMessage(checks.join(" · "))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function openSitePanel(view) {
    if (!current) return
    setBusy(true)
    setMessage("")
    try {
      setSiteDetails(await request(`site?domain=${encodeURIComponent(current.domain)}`))
      setModal(view)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function startSslRenewal(domain) {
    setSslResponse("")
    setSslJob({ domain, status: "starting", output: "Preparing the domain certificate inventory…" })
    setModal("ssl-renewal")
    try {
      const result = await request("ssl-renew", { domain })
      setSslJob(result.job)
    } catch (error) {
      setSslJob({ domain, status: "failed", output: error.message, exitCode: 1 })
    }
  }

  async function sendSslResponse(event) {
    event.preventDefault()
    if (!sslJob?.id || sslJob.status !== "running") return
    try {
      await request("ssl-input", { jobId: sslJob.id, text: sslResponse })
      setSslResponse("")
    } catch (error) {
      setMessage(error.message)
    }
  }

  async function previewAdoption() {
    if (!current) return
    setBusy(true)
    setMessage("")
    try {
      const result = await request("plan/adopt", { domain: current.domain })
      setPlan(result.plan)
      setConfirmation("")
      setModal("review")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  function resetFilters() {
    setSearch("")
    setFilter("All sites")
    setMessage("Search and filters cleared.")
  }

  function downloadPlan() {
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${plan.kind}-${plan.domain || plan.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const nav = (
    <>
      <div className="brand">
        <div className="brand-mark">
          <Server size={19} />
        </div>
        <div>
          <strong>
            eagles<span>vn</span>
          </strong>
          <small>SERVER CONTROL</small>
        </div>
      </div>
      <div className="nav-label">WORKSPACE</div>
      <button
        className="nav-item active"
        onClick={resetFilters}>
        <LayoutDashboard size={17} /> Overview <span className="nav-dot" />
      </button>
      <button
        className="nav-item"
        onClick={() => setModal("history")}>
        <Clock3 size={17} /> Activity log
      </button>
      <div className="sidebar-bottom">
        <button
          className="help-card"
          onClick={() => setModal("help")}>
          <div className="help-icon">
            <CircleHelp size={17} />
          </div>
          <div>
            <b>Need a hand?</b>
            <p>Review the server notes and setup guide.</p>
          </div>
          <ArrowRight size={15} />
        </button>
        <button
          className="sidebar-user"
          onClick={() => setModal("settings")}>
          <div className="avatar">EV</div>
          <div>
            <b>Server admin</b>
            <span>Local session</span>
          </div>
          <Settings2 size={17} />
        </button>
        <div className="runtime-actions">
          <button
            className="nav-item"
            onClick={() => controlRuntime("restart")}
            disabled={busy}>
            <RotateCw size={17} /> Restart
          </button>
          <button
            className="nav-item runtime-stop"
            onClick={() => controlRuntime("logoff")}
            disabled={busy}>
            <LogOut size={17} /> Log off
          </button>
        </div>
      </div>
    </>
  )

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "show" : ""}`}>{nav}</aside>
      {mobileNav && (
        <button
          aria-label="Close navigation"
          className="nav-scrim"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Open menu"
            onClick={() => setMobileNav(true)}>
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronDown size={14} />
            <strong>Overview</strong>
          </div>
          <div className="topbar-actions">
            <div
              className="text-scale-control"
              role="group"
              aria-label={isUhd ? "Text size controls; 4K display detected" : "Text size controls"}>
              <span className="text-size-label">Text size</span>
              <button
                className="display-control text-size-button"
                aria-label="Decrease text size A−"
                title="Decrease text size"
                disabled={textScale <= textScaleStops[0]}
                onClick={() => adjustTextScale(-1)}>
                A−
              </button>
              <span
                aria-live="polite"
                aria-atomic="true">
                {Math.round(textScale * 100)}%
              </span>
              <button
                className="display-control text-size-button"
                aria-label="Increase text size A+"
                title="Increase text size"
                disabled={textScale >= textScaleStops.at(-1)}
                onClick={() => adjustTextScale(1)}>
                A+
              </button>
              {isUhd && <span className="display-profile">4K UHD</span>}
            </div>
            <button
              className="display-control theme-toggle"
              aria-label={`${theme === "dark" ? "Dark" : "Light"} mode, switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-pressed={theme === "dark"}
              title={`${theme === "dark" ? "Dark" : "Light"} mode, switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
              <span>{theme === "dark" ? "Dark" : "Light"}</span>
            </button>
            <span className="local-badge">
              <span /> LOOPBACK ONLY
            </span>
            <button
              aria-label="Help"
              className="icon-button"
              onClick={() => setModal("help")}>
              <CircleHelp size={18} />
            </button>
            <div className="mini-avatar">EV</div>
          </div>
        </header>
        <div className="content-wrap">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                SERVER OVERVIEW <span>•</span> LOCAL MANAGEMENT
              </div>
              <h1>Vhost setup</h1>
              <p>
                {sites.some((site) => site.managed)
                  ? `${sites.filter((site) => site.managed).length} website(s) initialized by this manager.`
                  : "No websites have been initialized by this manager. Discovered server configs are reference examples."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={scan}
                disabled={busy}>
                <RefreshCw
                  size={16}
                  className={busy ? "spin" : ""}
                />{" "}
                Scan server
              </button>
              <button
                className="button primary"
                onClick={openCreate}>
                <Plus size={17} /> Create new website
              </button>
            </div>
          </div>
          {message && (
            <div
              className="toast"
              role="status">
              <span>{message}</span>
              <button
                onClick={() => setMessage("")}
                aria-label="Dismiss">
                <X size={15} />
              </button>
            </div>
          )}
          <section
            className="health-strip"
            aria-label="Server health">
            <div className="health-main">
              <div className={`health-symbol ${upCount === 2 ? "ok" : "warn"}`}>
                <Activity size={19} />
              </div>
              <div>
                <div className="health-title">
                  {upCount === 2 ? "All systems operational" : "Server needs attention"}{" "}
                  <span className="health-live">
                    <i /> LIVE
                  </span>
                </div>
                <p>
                  {upCount === 2
                    ? "Web services are responding on this server."
                    : "One or more web services need review."}
                </p>
              </div>
            </div>
            <div className="health-services">
              <Health
                name="Nginx"
                state={services?.nginx}
              />
              <Health
                name="OpenLiteSpeed"
                state={services?.ols}
              />
            </div>
            <div className="health-checked">Last checked just now</div>
          </section>
          <section className="stats-grid">
            <Stat
              icon={<Globe2 />}
              label="CONFIG RECORDS"
              value={String(sites.length).padStart(2, "0")}
              detail="Discovered configuration records"
              tint="green"
            />
            <Stat
              icon={<ShieldCheck />}
              label="ENABLED"
              value={String(sites.filter((site) => site.enabled).length).padStart(2, "0")}
              detail="Active Nginx links"
              tint="blue"
            />
            <Stat
              icon={<AlertTriangle />}
              label="NEEDS REVIEW"
              value={String(
                sites.filter((site) => site.drifted || site.status === "invalid").length
              ).padStart(2, "0")}
              detail="Drift or invalid config"
              tint="amber"
            />
            <Stat
              icon={<LockKeyhole />}
              label="TLS READY"
              value="—"
              detail="Certificate check pending"
              tint="purple"
            />
          </section>
          <SecurityOverview security={security} />
          <section className="sites-panel">
            <div className="panel-heading">
              <div>
                <h2>
                  Virtual hosts <span className="count-pill">{sites.length}</span>
                </h2>
                <p>Sites detected across Nginx and OpenLiteSpeed.</p>
              </div>
              <div className="panel-tools">
                <button
                  className="button text-button"
                  onClick={previewReset}
                  disabled={busy}>
                  <RotateCcw size={15} /> Preview clean initialization
                </button>
                <button
                  className="button small-primary"
                  onClick={openCreate}>
                  <Plus size={16} />
                  <span>New site</span>
                </button>
              </div>
            </div>
            <div className="table-toolbar">
              <div className="searchbox">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search websites"
                  aria-label="Search websites"
                />
              </div>
              <label className="filter-select">
                <ListFilter size={15} />
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filter sites">
                  <option>All sites</option>
                  <option>Enabled</option>
                  <option>Needs review</option>
                  <option>Invalid</option>
                  <option>Managed</option>
                  <option>Discovered</option>
                  <option>Pending TLS</option>
                </select>
                <ChevronDown size={14} />
              </label>
              <button
                className="icon-button filter-button"
                aria-label="Clear search and filters"
                title="Clear search and filters"
                onClick={resetFilters}>
                <ListFilter size={16} />
              </button>
            </div>
            <div
              className="site-list"
              role="listbox"
              aria-label="Virtual hosts">
              {visibleSites.map((site) => (
                <div
                  key={site.domain}
                  role="group"
                  aria-label={site.domain}
                  className={`site-row ${selected === site.domain ? "selected" : ""}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected === site.domain}
                    className="site-select"
                    onClick={() => setSelected(site.domain)}>
                    <div
                      className={`site-favicon ${site.status === "invalid" ? "favicon-warn" : ""}`}>
                      {site.domain.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="site-primary">
                      <b>{site.domain}</b>
                      <span>
                        {site.aliases.length
                          ? site.aliases.join(", ")
                          : site.olsVhosts[0]?.name || "No aliases detected"}
                      </span>
                    </div>
                  </button>
                  <span
                    className={`status-badge ${site.enabled ? "enabled" : site.status === "invalid" ? "invalid" : "disabled"}`}>
                    <i />
                    {site.enabled ? "Enabled" : site.status === "invalid" ? "Invalid" : "Disabled"}
                  </span>
                  <div className="site-tls-status">
                    {site.managed && site.tlsReady ? (
                      <span className="ssl-valid">
                        <span className="ssl-pill">SSL OK</span>
                        <time
                          dateTime={site.tls.expiresAt}
                          title={new Date(site.tls.expiresAt).toLocaleString()}>
                          {new Intl.DateTimeFormat(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            timeZone: "Asia/Ho_Chi_Minh",
                          }).format(new Date(site.tls.expiresAt))}
                        </time>
                      </span>
                    ) : site.managed ? (
                      <button
                        type="button"
                        className="ssl-pill ssl-needs"
                        aria-label={`Needs SSL for ${site.domain}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          startSslRenewal(site.domain)
                        }}>
                        Needs SSL
                      </button>
                    ) : null}
                  </div>
                  <span className="site-stack">
                    {site.nginxConfigs.length ? "Nginx" : "—"} <span>→</span>{" "}
                    {site.olsVhosts.length ? "OLS" : "—"}
                  </span>
                  <span className={`drift-indicator ${site.drifted ? "drifted" : ""}`}>
                    {site.drifted
                      ? "External changes"
                      : site.adoptedReadOnly
                        ? "Adopted · read-only"
                        : site.managed
                          ? "Managed"
                          : "Discovered config"}
                  </span>
                  <ArrowRight
                    className="row-arrow"
                    size={16}
                  />
                </div>
              ))}
              {visibleSites.length === 0 && (
                <div className="empty-state">
                  <Globe2 size={23} />
                  <b>
                    {sites.length
                      ? "No matching configuration records"
                      : "No websites initialized yet"}
                  </b>
                  <span>
                    {sites.length
                      ? "Change your search or filter."
                      : "Create a website to start. Server configuration is scanned separately."}
                  </span>
                  {!sites.length && (
                    <button
                      className="button primary"
                      onClick={openCreate}>
                      <Plus size={16} /> Create new website
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="panel-footer">
              <span>
                Showing <b>{visibleSites.length}</b> of <b>{sites.length}</b> websites
              </span>
              <span>Inventory from canonical server configs</span>
            </div>
          </section>
          <div
            className="create-form-slot"
            ref={createHostRef}
          />
          <section className="lower-grid">
            <div className="detail-card">
              <div className="card-title">
                <div>
                  <h2>Selected website</h2>
                  <p>Current configuration details</p>
                </div>
                <button
                  aria-label="More website details"
                  className="icon-button"
                  aria-expanded={detailExpanded}
                  onClick={() => setDetailExpanded((value) => !value)}>
                  <ChevronDown
                    size={17}
                    className={detailExpanded ? "rotate-chevron" : ""}
                  />
                </button>
              </div>
              {current ? (
                <div className="detail-content">
                  <div className="detail-domain">
                    <div className="site-favicon large">
                      {current.domain.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <b>{current.domain}</b>
                      <span>
                        {current.managed ? "Managed by Vhost Manager" : "Discovered from server"}
                      </span>
                    </div>
                    <span className={`status-badge ${current.enabled ? "enabled" : "disabled"}`}>
                      <i />
                      {current.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <div className="detail-items">
                    <Detail
                      label="WEBROOT"
                      value={current.webroot || "Not detected"}
                    />
                    <Detail
                      label="FRONTEND"
                      value={current.nginxConfigs[0] ? "Nginx" : "Not configured"}
                    />
                    <Detail
                      label="APPLICATION SERVER"
                      value={current.olsVhosts[0]?.name || "Not configured"}
                    />
                    <Detail
                      label="TLS CONFIG"
                      value="Check certificate paths"
                    />
                  </div>
                  {detailExpanded && (
                    <div className="expanded-details">
                      <Detail
                        label="NGINX CONFIGS"
                        value={current.nginxConfigs.join(", ") || "None"}
                      />
                      <Detail
                        label="OLS CONFIGS"
                        value={
                          current.olsVhosts.map((item) => item.path || item.name).join(", ") ||
                          "None"
                        }
                      />
                      <Detail
                        label="STATE"
                        value={
                          current.invalidReasons?.join(" · ") ||
                          (current.enabled ? "Enabled" : "Disabled configuration")
                        }
                      />
                      {current.managerSettings && (
                        <>
                          <Detail
                            label="OWNER / GROUP"
                            value={`${current.managerSettings.account || "unknown"} : ${current.managerSettings.group || "unknown"}`}
                          />
                          <Detail
                            label="REQUEST MODE"
                            value={current.managerSettings.requestMode || "Unknown"}
                          />
                          <Detail
                            label="PHP HANDLER"
                            value={current.managerSettings.phpBinary || "Not configured"}
                          />
                          <Detail
                            label="PHP INI"
                            value={current.managerSettings.phpIni || "Not configured"}
                          />
                          <Detail
                            label="CSP MODE"
                            value={current.managerSettings.cspMode || "Unknown"}
                          />
                        </>
                      )}
                    </div>
                  )}
                  {current.drifted && (
                    <div className="drift-callout">
                      <AlertTriangle size={16} /> External changes detected. Review the current
                      files before editing.
                    </div>
                  )}
                  <div className="card-actions">
                    <button
                      className="button secondary"
                      onClick={() => setModal("history")}>
                      <Clock3 size={15} /> View history
                    </button>
                    <button
                      className="button secondary"
                      onClick={validateConfigs}
                      disabled={busy}>
                      <FileCode2 size={15} /> Validate configs
                    </button>
                    <button
                      className="button secondary"
                      onClick={openEdit}
                      disabled={!current.managed || current.adoptedReadOnly}
                      title={
                        current.domain === "phpmyadmin"
                          ? "phpMyAdmin is protected and cannot be edited by the Vhost Manager."
                          : current.adoptedReadOnly
                            ? "Adopted vhosts are inventory-only and cannot be edited by the Vhost Manager."
                            : !current.managed
                              ? "Adopt to record this configuration before editing."
                              : "Edit managed settings"
                      }>
                      <Settings2 size={15} /> Edit settings
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => openSitePanel("config")}
                      disabled={busy}>
                      <FileCode2 size={15} /> View config
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => openSitePanel("webroot")}
                      disabled={busy}>
                      <Globe2 size={15} /> View webroot
                    </button>
                    {!current.managed && current.domain !== "phpmyadmin" && (
                      <button
                        className="button secondary"
                        onClick={previewAdoption}
                        disabled={busy}>
                        <Check size={15} /> Adopt
                      </button>
                    )}
                    <button
                      className="button secondary"
                      onClick={() => previewToggle(current.enabled ? "disable" : "enable")}
                      disabled={!current.managed}
                      title={
                        current.domain === "phpmyadmin"
                          ? "phpMyAdmin is protected; challenge config changes are unavailable."
                          : !current.managed
                            ? "Challenge config changes are available for manager-created sites."
                            : current.enabled
                              ? "Preview disabling this site's challenge config"
                              : "Preview enabling this site's challenge config"
                      }>
                      <ShieldCheck size={15} />{" "}
                      {current.enabled ? "Disable challenge config" : "Enable challenge config"}
                    </button>
                  </div>
                  {!current.managed && (
                    <p
                      className="action-notice"
                      role="note">
                      {current.domain === "phpmyadmin"
                        ? "phpMyAdmin is intentionally protected. You can inspect its files and webroot and validate the server configs; manager edits and challenge toggles stay unavailable to preserve its vhost, listener, credentials, and application."
                        : "This is a discovered server configuration. Adoption records its inventory details only; editing and challenge toggles are available for sites created by this manager."}
                    </p>
                  )}
                </div>
              ) : (
                <div className="detail-empty">
                  <b>No website selected</b>
                  <span>
                    {sites.some((site) => site.managed)
                      ? "Choose a record to inspect its configuration."
                      : "This manager has not initialized any websites. Discovered configuration remains reference material until you choose what to do with it."}
                  </span>
                  {!sites.some((site) => site.managed) && (
                    <button
                      className="button primary"
                      onClick={openCreate}>
                      <Plus size={15} /> Create the first website
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="activity-card">
              <div className="card-title">
                <div>
                  <h2>Recent activity</h2>
                  <p>Latest manager operations</p>
                </div>
                <button
                  className="text-link"
                  onClick={() => setModal("history")}>
                  View all <ArrowRight size={14} />
                </button>
              </div>
              {(status?.history || []).length ? (
                <div className="activity-list">
                  {status.history.slice(0, 3).map((item) => (
                    <div
                      className="activity-item"
                      key={item.id}>
                      <div
                        className={`activity-icon ${item.kind === "reset" ? "orange" : "green"}`}>
                        {item.kind === "reset" ? <RotateCcw size={15} /> : <Check size={15} />}
                      </div>
                      <div>
                        <b>{item.title}</b>
                        <span>{new Date(item.at).toLocaleString()}</span>
                      </div>
                      <span className="activity-state">{item.state}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="activity-empty">
                  <Clock3 size={20} />
                  <span>Manager activity will appear here after you apply a reviewed change.</span>
                </div>
              )}
            </div>
          </section>
          <footer className="page-footer">
            <span>
              Vhost Manager <b>v0.1</b>
            </span>
            <span>
              <LockKeyhole size={13} /> Local session · Bound to 127.0.0.1
            </span>
          </footer>
        </div>
      </main>

      {modal === "create" &&
        createHostRef.current &&
        createPortal(
          <section
            className="modal create-panel"
            aria-labelledby="create-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">
                  {editing ? "EDIT WEBSITE" : "NEW WEBSITE"} <span>•</span> STEP 1 OF 2
                </div>
                <h2 id="create-title">{editing ? `Edit ${form.domain}` : "Start with a domain"}</h2>
                <p>The manager will prepare a preview before changing server files.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setModal("")}
                aria-label="Close">
                <X size={19} />
              </button>
            </div>
            <form onSubmit={previewSite}>
              <label
                className="field-label"
                htmlFor="domain">
                Domain name <em>{editing ? "Managed site" : "Required"}</em>
              </label>
              <div className="input-wrap">
                <Globe2 size={17} />
                <input
                  autoFocus
                  id="domain"
                  required
                  disabled={editing}
                  placeholder="example.com"
                  value={form.domain}
                  onChange={(e) => changeDomain(e.target.value)}
                />
              </div>
              <small className="field-help">Enter the primary fully qualified domain name.</small>
              <label
                className="field-label"
                htmlFor="aliases">
                Aliases <em>Optional</em>
              </label>
              <input
                className="plain-input"
                id="aliases"
                placeholder="www.example.com, shop.example.com"
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
              />
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="siteLabel">
                    Site label
                  </label>
                  <input
                    className="plain-input"
                    id="siteLabel"
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="webroot">
                    Webroot
                  </label>
                  <input
                    className="plain-input"
                    id="webroot"
                    required
                    value={form.webroot}
                    onChange={(e) => setForm({ ...form, webroot: e.target.value })}
                  />
                </div>
              </div>
              <label
                className="field-label"
                htmlFor="notes">
                Notes
              </label>
              <textarea
                className="plain-input"
                id="notes"
                rows="2"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
              <h3 className="form-section-title">Optional database</h3>
              <div className="field-row">
                <div>
                  <b>Create a MySQL/MariaDB database</b>
                  <span>
                    Creates a new database and localhost-only user. A random password is shown once
                    after apply.
                  </span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Create a MySQL/MariaDB database"
                    disabled={editing}
                    checked={form.createDatabase}
                    onChange={(e) => setForm({ ...form, createDatabase: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              {form.createDatabase && (
                <div className="form-two">
                  <div>
                    <label
                      className="field-label"
                      htmlFor="databaseName">
                      Database name
                    </label>
                    <input
                      className="plain-input"
                      id="databaseName"
                      required
                      maxLength={64}
                      value={form.databaseName}
                      onChange={(e) => setForm({ ...form, databaseName: e.target.value })}
                    />
                  </div>
                  <div>
                    <label
                      className="field-label"
                      htmlFor="databaseUser">
                      Database user
                    </label>
                    <input
                      className="plain-input"
                      id="databaseUser"
                      required
                      maxLength={32}
                      value={form.databaseUser}
                      onChange={(e) => setForm({ ...form, databaseUser: e.target.value })}
                    />
                  </div>
                  <small className="field-help">
                    The user receives access only to this database from localhost. The password is
                    generated when you review the plan.
                  </small>
                </div>
              )}
              <h3 className="form-section-title">Webroot setup</h3>
              <div
                className="site-identity-note"
                role="note">
                <b>Dedicated site identity</b>
                <span>
                  Each site gets its own no-login Unix account and private primary group.
                  OpenLiteSpeed runs that site’s PHP processes as this account. The generated
                  account name appears in the review plan.
                </span>
              </div>
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="directoryMode">
                    Directory permissions
                  </label>
                  <select
                    className="plain-input"
                    id="directoryMode"
                    value={form.directoryMode}
                    onChange={(e) => setForm({ ...form, directoryMode: e.target.value })}>
                    <option value="0755">755 · public read/execute</option>
                    <option value="0750">750 · private group</option>
                    <option value="0775">775 · group writable</option>
                    <option value="0770">770 · private, group writable</option>
                  </select>
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="fileMode">
                    File permissions
                  </label>
                  <select
                    className="plain-input"
                    id="fileMode"
                    value={form.fileMode}
                    onChange={(e) => setForm({ ...form, fileMode: e.target.value })}>
                    <option value="0644">644 · public read</option>
                    <option value="0640">640 · private group</option>
                    <option value="0664">664 · group writable</option>
                    <option value="0660">660 · private, group writable</option>
                  </select>
                </div>
              </div>
              <div className="field-row">
                <div>
                  <b>Placeholder page</b>
                  <span>Write an index.html starter page into the new webroot.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Placeholder page"
                    checked={form.placeholder}
                    onChange={(e) => setForm({ ...form, placeholder: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <label
                className="field-label"
                htmlFor="robots">
                robots.txt
              </label>
              <select
                className="plain-input"
                id="robots"
                value={form.robots}
                onChange={(e) => setForm({ ...form, robots: e.target.value })}>
                <option value="allow">Allow indexing</option>
                <option value="block">Block crawling during setup</option>
                <option value="omit">Do not create</option>
              </select>
              <h3 className="form-section-title">Inbound firewall (iptables)</h3>
              <p className="field-help">
                TCP defaults to 80, 443. Enter comma-separated ports; applied rules allow all
                sources over IPv4 and IPv6 and persist through iptables-persistent.
              </p>
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="tcpPorts">
                    TCP ports
                  </label>
                  <input
                    className="plain-input"
                    id="tcpPorts"
                    inputMode="numeric"
                    placeholder="80, 443"
                    value={form.tcpPorts}
                    onChange={(e) => setForm({ ...form, tcpPorts: e.target.value })}
                  />
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="udpPorts">
                    UDP ports
                  </label>
                  <input
                    className="plain-input"
                    id="udpPorts"
                    inputMode="numeric"
                    placeholder="53, 51820"
                    value={form.udpPorts}
                    onChange={(e) => setForm({ ...form, udpPorts: e.target.value })}
                  />
                </div>
              </div>
              <h3 className="form-section-title">Request routing and PHP</h3>
              <label
                className="field-label"
                htmlFor="requestMode">
                Request mode
              </label>
              <select
                className="plain-input"
                id="requestMode"
                value={form.requestMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    requestMode: e.target.value,
                    htaccess: e.target.value === "ols" ? form.htaccess : false,
                  })
                }>
                <option value="ols">OpenLiteSpeed managed vhost</option>
                <option value="proxy">Proxy to a local upstream</option>
                <option value="static">Static files served by Nginx</option>
              </select>
              {form.requestMode === "proxy" && (
                <>
                  <label
                    className="field-label"
                    htmlFor="upstream">
                    Upstream host and port
                  </label>
                  <input
                    className="plain-input"
                    id="upstream"
                    value={form.upstream}
                    onChange={(e) => setForm({ ...form, upstream: e.target.value })}
                  />
                </>
              )}
              {form.requestMode === "ols" && (
                <div className="form-two">
                  <div>
                    <label
                      className="field-label"
                      htmlFor="phpBinary">
                      PHP handler
                    </label>
                    <select
                      className="plain-input"
                      id="phpBinary"
                      value={form.phpBinary}
                      onChange={(e) => setForm({ ...form, phpBinary: e.target.value })}>
                      {(status?.options?.phpHandlers || []).map((item) => (
                        <option
                          key={item}
                          value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      className="field-label"
                      htmlFor="phpIni">
                      PHP ini profile
                    </label>
                    <select
                      className="plain-input"
                      id="phpIni"
                      value={form.phpIni}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          phpIni: e.target.value,
                          ...phpFormValues(status?.options || {}, e.target.value),
                        })
                      }>
                      {(status?.options?.phpIniProfiles || []).map((item) => (
                        <option
                          key={item}
                          value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {form.requestMode === "ols" && (
                <section
                  className="php-settings"
                  aria-labelledby="php-settings-title">
                  <div className="section-heading">
                    <h3 id="php-settings-title">PHP settings</h3>
                    <p>
                      Values are prefilled from the selected profile. Edits apply only to this site.
                    </p>
                  </div>
                  <div className="form-two">
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpMemoryLimit">
                        Memory limit
                      </label>
                      <input
                        className="plain-input"
                        id="phpMemoryLimit"
                        value={form.phpMemoryLimit}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpMemoryLimit: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpUploadMaxFilesize">
                        Upload max filesize
                      </label>
                      <input
                        className="plain-input"
                        id="phpUploadMaxFilesize"
                        value={form.phpUploadMaxFilesize}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpUploadMaxFilesize: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpPostMaxSize">
                        Post max size
                      </label>
                      <input
                        className="plain-input"
                        id="phpPostMaxSize"
                        value={form.phpPostMaxSize}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpPostMaxSize: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpMaxExecutionTime">
                        Max execution time (seconds)
                      </label>
                      <input
                        className="plain-input"
                        id="phpMaxExecutionTime"
                        value={form.phpMaxExecutionTime}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpMaxExecutionTime: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpMaxInputTime">
                        Max input time (seconds)
                      </label>
                      <input
                        className="plain-input"
                        id="phpMaxInputTime"
                        value={form.phpMaxInputTime}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpMaxInputTime: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpMaxInputVars">
                        Max input variables
                      </label>
                      <input
                        className="plain-input"
                        id="phpMaxInputVars"
                        value={form.phpMaxInputVars}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpMaxInputVars: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpDateTimezone">
                        Date timezone
                      </label>
                      <input
                        className="plain-input"
                        id="phpDateTimezone"
                        value={form.phpDateTimezone}
                        placeholder="Not set in profile"
                        onChange={(e) => setForm({ ...form, phpDateTimezone: e.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpDisplayErrors">
                        Display errors
                      </label>
                      <select
                        className="plain-input"
                        id="phpDisplayErrors"
                        value={form.phpDisplayErrors}
                        onChange={(e) => setForm({ ...form, phpDisplayErrors: e.target.value })}>
                        <option value="">Use profile value</option>
                        <option value="0">Off</option>
                        <option value="1">On</option>
                      </select>
                    </div>
                    <div>
                      <label
                        className="field-label"
                        htmlFor="phpLogErrors">
                        Log errors
                      </label>
                      <select
                        className="plain-input"
                        id="phpLogErrors"
                        value={form.phpLogErrors}
                        onChange={(e) => setForm({ ...form, phpLogErrors: e.target.value })}>
                        <option value="">Use profile value</option>
                        <option value="0">Off</option>
                        <option value="1">On</option>
                      </select>
                    </div>
                  </div>
                  <label
                    className="field-label"
                    htmlFor="phpIniOverrides">
                    Advanced ini directives
                  </label>
                  <textarea
                    className="plain-input policy-input php-override-input"
                    id="phpIniOverrides"
                    value={form.phpIniOverrides}
                    placeholder={"opcache.memory_consumption = 192\nsession.cookie_httponly = 1"}
                    onChange={(e) => setForm({ ...form, phpIniOverrides: e.target.value })}
                  />
                  <p className="field-help">
                    One directive = value per line. These overrides are included in the reviewed
                    per-site PHP ini file.
                  </p>
                </section>
              )}
              {form.requestMode === "ols" && (
                <label
                  className="field-label"
                  htmlFor="olsListener">
                  OLS listener
                </label>
              )}
              {form.requestMode === "ols" && (
                <select
                  className="plain-input"
                  id="olsListener"
                  value={form.olsListener}
                  onChange={(e) => setForm({ ...form, olsListener: e.target.value })}>
                  {(status?.options?.listeners || ["Default"]).map((item) => (
                    <option
                      key={item}
                      value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              )}
              {form.requestMode === "ols" && (
                <div className="form-two">
                  <div>
                    <label className="field-label">OLS vhost name</label>
                    <div className="readonly-path">{form.domain || "<domain>"}</div>
                  </div>
                  <div>
                    <label className="field-label">OLS config file</label>
                    <div className="readonly-path">
                      {status?.options?.paths?.olsVhosts || "/usr/local/lsws/conf/vhosts"}/
                      {form.domain || "<domain>"}/vhconf.conf
                    </div>
                  </div>
                </div>
              )}
              <h3 className="form-section-title">Nginx and certificate paths</h3>
              <div className="field-row">
                <div>
                  <b>Redirect HTTP to HTTPS</b>
                  <span>Certificate activation remains separate until the files exist.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Redirect HTTP to HTTPS"
                    checked={form.httpRedirect}
                    onChange={(e) => setForm({ ...form, httpRedirect: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="nginxAccessLog">
                    Nginx access log
                  </label>
                  <input
                    className="plain-input"
                    id="nginxAccessLog"
                    value={form.nginxAccessLog}
                    onChange={(e) => setForm({ ...form, nginxAccessLog: e.target.value })}
                  />
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="nginxErrorLog">
                    Nginx error log
                  </label>
                  <input
                    className="plain-input"
                    id="nginxErrorLog"
                    value={form.nginxErrorLog}
                    onChange={(e) => setForm({ ...form, nginxErrorLog: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="certificatePath">
                    Certificate path
                  </label>
                  <input
                    className="plain-input"
                    id="certificatePath"
                    value={form.certificatePath}
                    onChange={(e) => setForm({ ...form, certificatePath: e.target.value })}
                  />
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="privateKeyPath">
                    Private key path
                  </label>
                  <input
                    className="plain-input"
                    id="privateKeyPath"
                    value={form.privateKeyPath}
                    onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-divider" />
              <div className="field-row">
                <div>
                  <b>OLS .htaccess template</b>
                  <span>Enable OpenLiteSpeed rewrite support for this site.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="OLS .htaccess template"
                    disabled={form.requestMode !== "ols"}
                    checked={form.htaccess}
                    onChange={(e) => setForm({ ...form, htaccess: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <h3 className="form-section-title">Security headers</h3>
              <div className="field-row">
                <div>
                  <b>HSTS with includeSubDomains</b>
                  <span>Use the eaglesvn.club template default.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="HSTS with includeSubDomains"
                    checked={form.hsts}
                    onChange={(e) => setForm({ ...form, hsts: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <div className="form-two">
                <div>
                  <label
                    className="field-label"
                    htmlFor="frameOptions">
                    Frame protection
                  </label>
                  <select
                    className="plain-input"
                    id="frameOptions"
                    value={form.frameOptions}
                    onChange={(e) => setForm({ ...form, frameOptions: e.target.value })}>
                    <option>SAMEORIGIN</option>
                    <option>DENY</option>
                  </select>
                </div>
                <div>
                  <label
                    className="field-label"
                    htmlFor="referrerPolicy">
                    Referrer policy
                  </label>
                  <select
                    className="plain-input"
                    id="referrerPolicy"
                    value={form.referrerPolicy}
                    onChange={(e) => setForm({ ...form, referrerPolicy: e.target.value })}>
                    <option>strict-origin</option>
                    <option>strict-origin-when-cross-origin</option>
                    <option>same-origin</option>
                    <option>no-referrer</option>
                  </select>
                </div>
              </div>
              <label
                className="field-label"
                htmlFor="permissionsPolicy">
                Permissions policy
              </label>
              <input
                className="plain-input"
                id="permissionsPolicy"
                value={form.permissionsPolicy}
                onChange={(e) => setForm({ ...form, permissionsPolicy: e.target.value })}
              />
              <label
                className="field-label"
                htmlFor="cspSource">
                CSP policy source
              </label>
              <select
                className="plain-input"
                id="cspSource"
                value={form.cspSource}
                onChange={(e) => setForm({ ...form, cspSource: e.target.value })}>
                <option value="global">Global default policy</option>
                <option value="custom">Custom site policy</option>
              </select>
              <small className="field-help">
                Global uses the manager-wide baseline for this site. Custom starts with the same
                complete directive set and lets you edit it for this site.
              </small>
              <label
                className="field-label"
                htmlFor="cspMode">
                CSP delivery mode
              </label>
              <select
                className="plain-input"
                id="cspMode"
                value={form.cspMode}
                onChange={(e) => setForm({ ...form, cspMode: e.target.value })}>
                <option value="report-only">Report only (recommended to start)</option>
                <option value="enforce">Enforce policy</option>
                <option value="off">Off</option>
              </select>
              {form.cspMode !== "off" && (
                <>
                  <label
                    className="field-label"
                    htmlFor="cspPolicy">
                    {form.cspSource === "global" ? "Global CSP policy" : "Custom CSP policy"}
                  </label>
                  <textarea
                    className="plain-input policy-input"
                    id="cspPolicy"
                    rows="14"
                    readOnly={form.cspSource === "global"}
                    value={
                      form.cspSource === "global"
                        ? status?.options?.globalCspPolicy || starterPolicy
                        : form.cspPolicy
                    }
                    onChange={(e) => setForm({ ...form, cspPolicy: e.target.value })}
                  />
                  {form.cspSource === "custom" && (
                    <button
                      className="text-action csp-reset"
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          cspPolicy: status?.options?.globalCspPolicy || starterPolicy,
                        })
                      }>
                      Reset custom policy to global defaults
                    </button>
                  )}
                </>
              )}
              <h3 className="form-section-title">MIME types and cache</h3>
              <label
                className="field-label"
                htmlFor="mimeOverrides">
                Additional MIME mappings <em>Optional · one per line</em>
              </label>
              <textarea
                className="plain-input policy-input"
                id="mimeOverrides"
                placeholder={"application/wasm wasm\napplication/manifest+json webmanifest"}
                value={form.mimeOverrides}
                onChange={(e) => setForm({ ...form, mimeOverrides: e.target.value })}
              />
              <small className="field-help">
                The system mime.types map is retained and merged with these overrides.
              </small>
              <label
                className="field-label"
                htmlFor="staticCache">
                Site cache profile
              </label>
              <select
                className="plain-input"
                id="staticCache"
                value={form.staticCache}
                onChange={(e) =>
                  setForm({
                    ...form,
                    staticCache: e.target.value,
                    ...(e.target.value === "dev" ? { proxyCache: false } : {}),
                  })
                }>
                <option value="off">Off</option>
                <option value="dev">Development · no-store</option>
                <option value="5m">5 minutes</option>
                <option value="1h">1 hour</option>
                <option value="30d">30 days</option>
              </select>
              <div className="field-row cache-row">
                <div>
                  <b>Shared Nginx proxy cache</b>
                  <span>
                    {form.staticCache === "dev"
                      ? "Disabled by the development no-store profile."
                      : status?.capabilities?.cacheZone
                        ? "Explicit opt-in. Authorization, cookies, query strings, and Set-Cookie responses bypass cache."
                        : "Unavailable: no global cache_zone is configured."}
                  </span>
                </div>
                <label
                  className={`switch ${status?.capabilities?.cacheZone ? "" : "switch-disabled"}`}>
                  <input
                    type="checkbox"
                    aria-label="Shared Nginx proxy cache"
                    disabled={!status?.capabilities?.cacheZone || form.staticCache === "dev"}
                    checked={form.proxyCache}
                    onChange={(e) => setForm({ ...form, proxyCache: e.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <div className="modal-note">
                <ShieldCheck size={16} />
                <span>
                  The global CSP includes the Eagles, GPTpatient, and EaglesVN domains and the
                  shared vendor sources. Review a custom policy for site-specific integrations. TLS
                  activation stays separate until certificate files are ready.
                </span>
              </div>
              {message && <div className="inline-error">{message}</div>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setModal("")}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy}>
                  {busy ? "Preparing…" : "Review plan"} <ArrowRight size={16} />
                </button>
              </div>
            </form>
          </section>,
          createHostRef.current
        )}

      {modal === "review" && plan && (
        <div className="modal-backdrop">
          <section
            className="modal review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">
                  CHANGE REVIEW <span>•</span> PREVIEW ONLY
                </div>
                <h2 id="review-title">{plan.title}</h2>
                <p>{plan.summary}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setModal(plan.kind === "site" ? "create" : "")}
                aria-label="Close">
                <X size={19} />
              </button>
            </div>
            <div className="review-warning">
              <ShieldCheck size={17} />
              <div>
                <b>
                  {plan.kind === "adopt"
                    ? "Metadata-only operation"
                    : "Backup and validation are included"}
                </b>
                <span>
                  {plan.kind === "adopt"
                    ? "This records paths and hashes only; server files and services are unchanged."
                    : "Every listed change is backed up before apply. Nginx and OLS must both validate before reload."}
                </span>
              </div>
            </div>
            {plan.preserve?.length > 0 && (
              <div className="review-warning preserve-list">
                <ShieldCheck size={17} />
                <div>
                  <b>Protected resources preserved</b>
                  <ul>
                    {plan.preserve.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {plan.archivePath && (
              <div className="review-warning archive-review">
                <ArrowDownToLine size={17} />
                <div>
                  <b>
                    {plan.archivedAt
                      ? "Example configs are saved in the archive"
                      : "Example configs will be saved in the archive"}
                  </b>
                  <span>
                    {plan.archivedAt
                      ? "Root-only copies are saved here. Active server configs remain unchanged until you apply the separate reset plan:"
                      : "Save exact file copies and the prior OLS main config here before active config paths are cleared:"}
                  </span>
                  <code>{plan.archivePath}</code>
                </div>
              </div>
            )}
            {plan.warnings?.map((warning) => (
              <div
                className="warning-line"
                key={warning}>
                <AlertTriangle size={15} />
                {warning}
              </div>
            ))}
            {plan.kind === "site" && plan.database?.enabled && (
              <div className="review-warning">
                <Server size={17} />
                <div>
                  <b>Database resources to create</b>
                  <span>
                    {plan.database.engine} schema <code>{plan.database.name}</code> and localhost
                    user <code>{plan.database.user}</code>. The generated password is delivered once
                    after apply and is not saved in manager history.
                  </span>
                </div>
              </div>
            )}
            {plan.kind === "site" && plan.directories?.length > 0 && (
              <div className="file-list directory-list">
                <div className="file-list-head">
                  <span>DIRECTORIES, OWNERSHIP, AND MODES</span>
                  <b>{plan.directories.length} items</b>
                </div>
                {plan.directories.map((directory) => (
                  <div
                    className="directory-review"
                    key={directory.path}>
                    <code>{directory.path}</code>
                    <span>
                      {directory.action} · {directory.owner}:{directory.group} · {directory.mode}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {plan.kind === "reset" && plan.directories?.length > 0 && (
              <div className="file-list directory-list">
                <div className="file-list-head">
                  <span>EMPTY DIRECTORIES TO REMOVE</span>
                  <b>{plan.directories.length} items</b>
                </div>
                {plan.directories.map((directory) => (
                  <div
                    className="directory-review"
                    key={directory}>
                    <code>{directory}</code>
                    <span>remove only if empty</span>
                  </div>
                ))}
              </div>
            )}
            {plan.kind === "site" && plan.firewall?.addressFamilies?.length > 0 && (
              <div className="file-list directory-list">
                <div className="file-list-head">
                  <span>IPTABLES FIREWALL RULES</span>
                  <b>{plan.firewall.rules.length} changes</b>
                </div>
                <p className="field-help">
                  Rules apply to IPv4 and IPv6 INPUT traffic and are saved in both persistent rules
                  files. All allowed ports accept traffic from any source.
                </p>
                {plan.firewall.rules.map((rule) => (
                  <div
                    className="directory-review"
                    key={`${rule.action}-${rule.protocol}-${rule.port}`}>
                    <code>
                      {rule.protocol.toUpperCase()} {rule.port}
                    </code>
                    <span>{rule.action}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="file-list">
              <div className="file-list-head">
                <span>FILES AND CONFIGURATION CHANGES</span>
                <b>{plan.files.length} items</b>
              </div>
              {plan.files.map((file) => (
                <details
                  className="file-item"
                  key={file.path}>
                  <summary>
                    <FileCode2 size={15} />
                    <span>{file.path}</span>
                    <i className={`file-action ${file.action}`}>{file.action}</i>
                    <ChevronDown size={14} />
                  </summary>
                  {file.mode != null && (
                    <small className="file-metadata">
                      owner {file.owner || "preserved"}:{file.group || file.owner || "preserved"} ·
                      mode {Number(file.mode).toString(8).padStart(4, "0")}
                    </small>
                  )}
                  <pre>{file.diff || file.after || "(no content change)"}</pre>
                </details>
              ))}
            </div>
            {plan.kind === "reset" && (
              <button
                className="button secondary archive-action"
                type="button"
                onClick={archiveCurrentExamples}
                disabled={busy || Boolean(plan.archivedAt)}>
                <ArrowDownToLine size={15} />{" "}
                {plan.archivedAt ? "Examples archived" : "Save examples to archive only"}
              </button>
            )}
            <button
              className="button secondary"
              type="button"
              onClick={downloadPlan}>
              <ArrowDownToLine size={15} /> Download this review plan
            </button>
            <label
              className="confirm-label"
              htmlFor="confirm">
              Type <b>{plan.confirmation}</b> to apply
            </label>
            <input
              className="plain-input"
              id="confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={plan.confirmation}
            />
            {message && <div className="inline-error">{message}</div>}
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  setModal("")
                  setPlan(null)
                }}>
                Cancel changes
              </button>
              <button
                className="button primary"
                onClick={apply}
                disabled={busy || confirmation !== plan.confirmation}>
                {busy ? "Applying…" : "Apply reviewed changes"} <Check size={16} />
              </button>
            </div>
          </section>
        </div>
      )}

      {modal === "database-credentials" && databaseCredentials && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="database-credentials-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">DATABASE CREATED</div>
                <h2 id="database-credentials-title">Save these credentials</h2>
                <p>The password is shown once. The manager does not retain it.</p>
              </div>
            </div>
            <div className="directory-review">
              <span>Host</span>
              <code>{databaseCredentials.host}</code>
            </div>
            <div className="directory-review">
              <span>Database</span>
              <code>{databaseCredentials.database}</code>
            </div>
            <div className="directory-review">
              <span>Username</span>
              <code>{databaseCredentials.username}</code>
            </div>
            <div className="directory-review">
              <span>Password</span>
              <code>{databaseCredentials.password}</code>
            </div>
            <div className="modal-actions">
              <button
                className="button primary"
                onClick={() => {
                  setDatabaseCredentials(null)
                  setModal("")
                }}>
                Saved credentials <Check size={16} />
              </button>
            </div>
          </section>
        </div>
      )}

      {modal === "ssl-renewal" && sslJob && (
        <div className="modal-backdrop ssl-renewal-backdrop">
          <section
            className="modal ssl-renewal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ssl-renewal-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">CERTIFICATE SETUP</div>
                <h2 id="ssl-renewal-title">SSL for {sslJob.domain}</h2>
                <p>
                  The script runs in a root login shell (<code>sudo -i</code>), checks DNS and
                  Nginx, then guides you through the manual DNS TXT challenge. Enter the exact
                  response requested by each prompt.
                </p>
              </div>
              {sslJob.status !== "running" && sslJob.status !== "starting" && (
                <button
                  className="icon-button"
                  onClick={() => setModal("")}
                  aria-label="Close SSL renewal output">
                  <X size={19} />
                </button>
              )}
            </div>
            <pre
              className="ssl-terminal-output"
              ref={sslOutputRef}
              aria-label="SSL renewal terminal output">
              {sslJob.output || "Starting renewal…"}
            </pre>
            <form
              className="ssl-terminal-input"
              onSubmit={sendSslResponse}>
              <label htmlFor="ssl-terminal-response">Terminal response</label>
              <div>
                <input
                  id="ssl-terminal-response"
                  value={sslResponse}
                  onChange={(event) => setSslResponse(event.target.value)}
                  disabled={sslJob.status !== "running"}
                  autoComplete="off"
                  placeholder="Enter response for the current prompt"
                />
                <button
                  className="button primary"
                  type="submit"
                  disabled={sslJob.status !== "running"}>
                  Send response
                </button>
              </div>
              <small>
                At restore checkpoints, enter <code>r</code> to roll back and quit.
              </small>
            </form>
            {sslJob.status !== "running" && sslJob.status !== "starting" && (
              <div className={`ssl-job-result ${sslJob.status}`}>
                {sslJob.status === "completed"
                  ? sites.find((site) => site.domain === sslJob.domain)?.tlsReady
                    ? "SSL OK. The expiry date is now shown beside the pill."
                    : "The script completed, but no valid certificate was detected yet. Review the terminal output."
                  : `Renewal stopped with exit code ${sslJob.exitCode ?? "unknown"}. Review the terminal output and correct the reported issue.`}
              </div>
            )}
          </section>
        </div>
      )}

      {modal === "history" && (
        <div className="modal-backdrop">
          <section
            className="modal history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">AUDIT TRAIL</div>
                <h2 id="history-title">Operation history</h2>
                <p>Backups and validation results for manager changes.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setModal("")}
                aria-label="Close">
                <X size={19} />
              </button>
            </div>
            <div className="history-list">
              {(status?.history || []).map((item) => (
                <div
                  className="history-row"
                  key={item.id}>
                  <div className="activity-icon green">
                    <Check size={15} />
                  </div>
                  <div className="history-info">
                    <b>{item.title}</b>
                    <span>
                      {new Date(item.at).toLocaleString()} · {item.files?.length || 0} paths ·{" "}
                      {item.state}
                    </span>
                    <code>{item.backup}</code>
                  </div>
                  {item.rollbackAvailable && (
                    <button
                      className="button secondary compact"
                      onClick={() => rollback(item.id)}>
                      <RotateCcw size={14} /> Roll back
                    </button>
                  )}
                </div>
              ))}
              {!status?.history?.length && (
                <div className="activity-empty">No operations have been applied.</div>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setModal("")}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {["help", "settings", "config", "webroot"].includes(modal) && (
        <div
          className="modal-backdrop"
          role="presentation">
          <section
            className="modal history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-title">
            <div className="modal-header">
              <div>
                <div className="eyebrow">LOCAL VHOST MANAGER</div>
                <h2 id="info-title">
                  {modal === "help"
                    ? "Setup guide"
                    : modal === "settings"
                      ? "Server paths and options"
                      : modal === "config"
                        ? `${siteDetails?.domain || "Site"} configuration`
                        : `${siteDetails?.domain || "Site"} webroot`}
                </h2>
                <p>
                  {modal === "help"
                    ? "Create a site, review the exact file plan, then apply only after confirming the preview."
                    : modal === "settings"
                      ? "Detected paths and choices used to prepare plans on this server."
                      : modal === "config"
                        ? "Read-only view of discovered site config files."
                        : "Read-only view of the detected webroot contents."}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setModal("")}
                aria-label="Close">
                <X size={19} />
              </button>
            </div>
            {modal === "help" && (
              <div className="info-content">
                <p>
                  <b>New server:</b> the manager starts with no websites of its own. Existing Nginx
                  and OLS records remain labeled as discovered configuration and can be inspected or
                  archived as examples.
                </p>
                <ol>
                  <li>Create a site beginning with its domain.</li>
                  <li>
                    Set webroot, ownership, permissions, routing, PHP, Nginx, and security defaults.
                  </li>
                  <li>Review the generated diff and use the exact confirmation phrase to apply.</li>
                </ol>
                <p>
                  Start CSP in report-only mode. Keep production TLS disabled until valid
                  certificate files exist.
                </p>
                <button
                  className="button primary"
                  onClick={openCreate}>
                  <Plus size={15} /> Create new website
                </button>
              </div>
            )}
            {modal === "settings" && (
              <div className="info-content">
                <dl>
                  {Object.entries(status?.options?.paths || {}).map(([key, value]) => (
                    <React.Fragment key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <p>
                  API runs as root but listens only on 127.0.0.1. State and backups are stored under
                  root-owned system directories.
                </p>
              </div>
            )}
            {modal === "config" && (
              <div className="info-content">
                {siteDetails?.files?.length ? (
                  siteDetails.files.map((file) => (
                    <details
                      className="file-item"
                      key={file.path}
                      open>
                      <summary>
                        <FileCode2 size={15} />
                        <span>{file.path}</span>
                      </summary>
                      <pre>
                        {file.content}
                        {file.truncated ? "\n… truncated at 64 KiB" : ""}
                      </pre>
                    </details>
                  ))
                ) : (
                  <p>No readable configuration files were found.</p>
                )}
              </div>
            )}
            {modal === "webroot" && (
              <div className="info-content">
                <p>
                  <b>Path:</b> {siteDetails?.webroot}
                </p>
                {siteDetails?.entries?.length ? (
                  <ul>
                    {siteDetails.entries.map((entry) => (
                      <li key={entry.name}>
                        <code>{entry.name}</code> · {entry.type}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Directory is missing or empty.</p>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setModal("")}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Health({ name, state }) {
  const ok = state?.active && state?.configValid
  return (
    <div className="service-health">
      <span className={`service-dot ${ok ? "ok" : "bad"}`} />
      <div>
        <b>{name}</b>
        <small>
          {!state
            ? "Checking…"
            : !state.active
              ? "Stopped"
              : state.configValid
                ? "Healthy"
                : "Config issue"}
        </small>
      </div>
    </div>
  )
}
function Stat({ icon, label, value, detail, tint }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tint}`}>{icon}</div>
      <div className="stat-copy">
        <span>{label}</span>
        <b>{value}</b>
        <small>{detail}</small>
      </div>
    </div>
  )
}
function SecurityOverview({ security }) {
  const summary = security?.summary
  const sources = security?.sources
  const formattedTime = security?.generatedAt
    ? new Date(security.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—"
  const metricCards = [
    {
      label: "WEB REQUESTS",
      value: summary?.requests ?? "—",
      detail: "Nginx access logs · 24 hours",
      icon: <Globe2 />,
    },
    {
      label: "ATTACK SIGNALS",
      value: summary?.attackSignals ?? "—",
      detail: "Exploit paths and scanner probes",
      icon: <ShieldAlert />,
    },
    {
      label: "FAILED SSH LOGINS",
      value: summary?.failedLogins ?? "—",
      detail: "SSH authentication failures · 24 hours",
      icon: <ShieldAlert />,
    },
    {
      label: "ACTIVE BLOCKS",
      value: summary?.activeBlocks ?? "—",
      detail: "CrowdSec IP decisions",
      icon: <ShieldCheck />,
    },
    {
      label: "WEB DENIALS",
      value: summary?.deniedRequests ?? "—",
      detail: "HTTP 401, 403, 429, 444",
      icon: <AlertTriangle />,
    },
  ]
  const protection = [
    { label: "Nginx access logs", value: sources?.nginx?.available ? "Reading" : "Unavailable" },
    {
      label: "CrowdSec service",
      value: sources?.crowdsec?.active ? "Active" : "Unavailable",
    },
    {
      label: "SSH authentication logs",
      value: sources?.ssh?.available ? "Reading" : "Unavailable",
    },
    {
      label: "CrowdSec SSH ingestion",
      value: sources?.ssh?.acquisitionConfiguredInCrowdSec ? "Configured" : "Not detected",
    },
    {
      label: "Firewall bouncer",
      value: sources?.crowdsec?.bouncerActive ? "Active" : "Unavailable",
    },
    {
      label: "CrowdSec Nginx ingestion",
      value: sources?.nginx?.acquisitionConfiguredInCrowdSec ? "Configured" : "Not detected",
    },
    {
      label: "Country lookup",
      value: sources?.geoip?.available ? "Local database" : "Not installed",
    },
  ]

  return (
    <section
      className="security-panel"
      aria-labelledby="security-title">
      <header className="security-heading">
        <div>
          <div className="eyebrow">THREAT MONITORING · LAST 24 HOURS</div>
          <h2 id="security-title">Attacks and blocks</h2>
        </div>
        <div className="security-updated">
          {security?.error ? "Metrics unavailable" : `Updated ${formattedTime}`}
        </div>
      </header>
      {security?.error ? (
        <p
          className="security-error"
          role="status">
          Security metrics could not be loaded: {security.error}
        </p>
      ) : (
        <>
          <div className="security-metrics">
            {metricCards.map((metric) => (
              <article
                className="security-metric"
                key={metric.label}>
                <div className="security-metric-icon">{metric.icon}</div>
                <div>
                  <span>{metric.label}</span>
                  <b>
                    {Number.isFinite(metric.value) ? metric.value.toLocaleString() : metric.value}
                  </b>
                  <small>{metric.detail}</small>
                </div>
              </article>
            ))}
          </div>
          <div className="security-details">
            <section
              className="security-detail-card"
              aria-labelledby="security-sources-title">
              <div className="security-card-heading">
                <div>
                  <h3 id="security-sources-title">Source IPs and countries</h3>
                  <p>IPs with SSH failures, web signals, denials, or an active block.</p>
                </div>
                <span className="security-pill">{summary?.uniqueAttackIps ?? 0} source IPs</span>
              </div>
              {security?.topSources?.length ? (
                <div className="security-table-scroll">
                  <table className="security-table">
                    <caption className="security-visually-hidden">
                      SSH failures, web attack signals, and active blocks grouped by source IP
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Source IP</th>
                        <th scope="col">Country</th>
                        <th scope="col">Signals</th>
                        <th scope="col">SSH failures</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {security.topSources.map((source) => (
                        <tr key={source.ip}>
                          <td>
                            <code>{source.ip}</code>
                          </td>
                          <td>{source.country || "Unknown"}</td>
                          <td>{source.attackSignals.toLocaleString()}</td>
                          <td>{(source.failedLogins ?? 0).toLocaleString()}</td>
                          <td>
                            <span className="security-pill">
                              {source.permanent
                                ? "Permanent"
                                : source.blocked
                                  ? "Blocked"
                                  : "Observed"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="security-empty">
                  No SSH failures, web attack signals, or denials in this 24-hour window.
                </p>
              )}
              <p className="security-note">
                {sources?.geoip?.available
                  ? "Country labels use the local GeoIP database. No external IP lookup is performed."
                  : (sources?.geoip?.reason ??
                    "Country data is unknown until a GeoIP database is installed.")}
              </p>
            </section>
            <aside
              className="security-detail-card protection-card"
              aria-labelledby="protection-title">
              <div className="security-card-heading">
                <div>
                  <h3 id="protection-title">Protection sources</h3>
                  <p>Live status of the systems feeding these counts.</p>
                </div>
              </div>
              <ul className="protection-list">
                {protection.map((source) => (
                  <li key={source.label}>
                    <span>{source.label}</span>
                    <span className="security-pill">{source.value}</span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
          <p className="security-method-note">
            Attack signals are requests to known exploit paths or known scanner clients. They do not
            by themselves confirm a compromise. Active blocks are current CrowdSec IP decisions.
          </p>
        </>
      )}
    </section>
  )
}
function Detail({ label, value }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
