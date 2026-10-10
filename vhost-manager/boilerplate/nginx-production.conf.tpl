server {
    listen 80;
    listen [::]:80;
    server_name {{SERVER_NAMES}};

    location /.well-known/acme-challenge/ {
        root {{WEBROOT}};
        try_files $uri =404;
    }

{{HTTP_REDIRECT}}
    error_log {{ERROR_LOG_80}} warn;
    access_log {{ACCESS_LOG_80}};
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{SERVER_NAMES}};

    ssl_certificate {{CERTIFICATE_PATH}};
    ssl_certificate_key {{PRIVATE_KEY_PATH}};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    resolver 8.8.8.8 203.113.131.2 8.8.4.4 valid=300s;
    resolver_timeout 5s;
    add_header Alt-Svc 'h3=":443"; ma=86400';

{{SECURITY_HEADERS}}
{{MIME_TYPES}}
{{STATIC_CACHE}}
{{BAD_BOT_BLOCK}}
    if ($http_user_agent ~* "(masscan|sqlmap|nmap|nikto|acunetix|wpscan|curl|python|java|httpclient|Go-http-client|wget)") {
        return 403 "Forbidden: Bad bot detected.";
    }

    location / {
        proxy_pass http://{{UPSTREAM}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
{{PROXY_CACHE}}
{{RATE_LIMIT}}
        proxy_buffering off;
    }

{{GEOIP_BLOCK}}

    error_log {{ERROR_LOG_443}} warn;
    access_log {{ACCESS_LOG_443}};
}
