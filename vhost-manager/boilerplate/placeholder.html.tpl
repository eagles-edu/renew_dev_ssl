<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <title>Domain Parked | Welcome</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent: #38bdf8;
            --success: #34d399;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }

        .container {
            width: 100%;
            max-width: 600px;
            padding: 20px;
            box-sizing: border-box;
        }

        .card {
            background-color: var(--card-bg);
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
            text-align: center;
            border: 1px solid #334155;
        }

        h1 {
            font-size: 2rem;
            margin-bottom: 5px;
            letter-spacing: -0.025em;
        }

        .domain-name {
            color: var(--accent);
            font-weight: 600;
        }

        p.subtitle {
            color: var(--text-muted);
            margin-top: 0;
            margin-bottom: 25px;
        }

        .metric-group {
            margin-top: 25px;
            border-top: 1px solid #334155;
            padding-top: 20px;
            text-align: left;
        }

        .metric-title {
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-muted);
            margin-bottom: 12px;
            font-weight: 700;
        }

        .metric-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            font-size: 0.95rem;
            font-family: monospace;
        }

        .metric-label {
            color: var(--text-muted);
        }

        .metric-value {
            color: var(--success);
        }
    </style>
</head>
<body>

    <div class="container">
        <div class="card">
            <h1>Welcome to <span class="domain-name" id="domain-display">Domain</span></h1>
            <p class="subtitle">This domain has been successfully registered and is currently under construction.</p>

            <!-- Date Display -->
            <div class="metric-row" style="font-family: inherit; justify-content: center; gap: 10px; margin-bottom: 15px;">
                <span class="metric-label">Current Date:</span>
                <span id="current-date" style="color: var(--text-main); font-weight: 500;">Loading...</span>
            </div>

            <!-- DNS Information Grid -->
            <div class="metric-group">
                <div class="metric-title">DNS & Host Information</div>
                <div class="metric-row">
                    <span class="metric-label">Hostname:</span>
                    <span class="metric-value" id="dns-host">-</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Protocol:</span>
                    <span class="metric-value" id="dns-protocol">-</span>
                </div>
            </div>

            <!-- Connection Metrics Grid -->
            <div class="metric-group">
                <div class="metric-title">Real-time Connection Metrics</div>
                <div class="metric-row">
                    <span class="metric-label">Network Type:</span>
                    <span class="metric-value" id="conn-type">Detecting...</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Round Trip Time (RTT):</span>
                    <span class="metric-value" id="conn-rtt">Detecting...</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Downlink Speed:</span>
                    <span class="metric-value" id="conn-downlink">Detecting...</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Page Load Time:</span>
                    <span class="metric-value" id="perf-load">Calculating...</span>
                </div>
            </div>
        </div>
    </div>

    <script>
        // 1. Dynamic Domain & Date Script
        document.addEventListener("DOMContentLoaded", () => {
            const hostname = window.location.hostname || "your domain";
            document.getElementById('domain-display').textContent = hostname;
            document.getElementById('dns-host').textContent = hostname;
            document.getElementById('dns-protocol').textContent = window.location.protocol;

            // Format current date cleanly
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', options);
        });

        // 2. Connection Metrics Script (Network Information API)
        function updateConnectionMetrics() {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

            if (connection) {
                document.getElementById('conn-type').textContent = (connection.effectiveType || 'unknown').toUpperCase();
                document.getElementById('conn-rtt').textContent = connection.rtt ? `${connection.rtt} ms` : 'N/A';
                document.getElementById('conn-downlink').textContent = connection.downlink ? `${connection.downlink} Mbps` : 'N/A';
            } else {
                document.getElementById('conn-type').textContent = 'Not supported by browser';
                document.getElementById('conn-rtt').textContent = 'N/A';
                document.getElementById('conn-downlink').textContent = 'N/A';
            }
        }

        // Run network check instantly and listen for changes
        updateConnectionMetrics();
        if (navigator.connection) {
            navigator.connection.addEventListener('change', updateConnectionMetrics);
        }

        // 3. Page Load Performance Metrics
        window.addEventListener('load', () => {
            // Using a slight timeout ensures all load events complete for accurate measurement
            setTimeout(() => {
                const [navigation] = performance.getEntriesByType('navigation');
                if (navigation) {
                    const loadTime = (navigation.loadEventEnd - navigation.startTime).toFixed(0);
                    document.getElementById('perf-load').textContent = `${loadTime} ms`;
                } else {
                    document.getElementById('perf-load').textContent = 'N/A';
                }
            }, 0);
        });
    </script>
</body>
</html>
