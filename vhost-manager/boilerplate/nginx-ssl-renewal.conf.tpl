server {
    listen 80;
    listen [::]:80;
    server_name {{SERVER_NAMES}};

    location /.well-known/acme-challenge/ {
        root {{WEBROOT}};
        try_files $uri =404;
    }

    location / {
{{HTTP_GEOIP_BLOCK}}
{{HTTP_CACHE_POLICY}}
        proxy_pass http://{{UPSTREAM}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    error_log {{RENEWAL_ERROR_LOG}} warn;
    access_log {{RENEWAL_ACCESS_LOG}};
}
