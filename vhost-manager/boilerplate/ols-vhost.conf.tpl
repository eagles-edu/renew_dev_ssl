docRoot {{WEBROOT}}/
vhDomain {{DOMAIN}}
vhAliases {{ALIASES}}
enableGzip 1

index {
  useServer 0
  indexFiles index.html,index.php
  autoIndex 0
}

context / {
  location $DOC_ROOT/
  allowBrowse 1
  rewrite {
    enable 1
    autoLoadHtaccess 1
  }
}

rewrite {
  enable 1
  autoLoadHtaccess 1
}

errorlog {{OLS_ERROR_LOG}} {
  useServer 0
  logLevel WARN
  rollingSize 10M
}

accesslog {{OLS_ACCESS_LOG}} {
  useServer 0
  keepDays 30
  rollingSize 10M
  compressArchive 1
}

scriptHandler {
  add lsapi:{{PHP_HANDLER}} php
}

extprocessor {{PHP_HANDLER}} {
  type lsapi
  address uds://{{PHP_SOCKET}}
  maxConns 10
  env PHP_LSAPI_CHILDREN=10
  env PHPRC={{PHP_INI}}
  env PHP_INI_SCAN_DIR={{PHP_SCAN_DIR}}
  initTimeout 60
  retryTimeout 0
  persistConn 1
  respBuffer 0
  autoStart 1
  path {{PHP_BINARY}}
  extUser {{SITE_USER}}
  extGroup {{SITE_GROUP}}
  backlog 100
  instances 1
  priority 0
  memSoftLimit 0
  memHardLimit 0
  procSoftLimit 400
  procHardLimit 450
}

phpIniOverride {
  php_admin_value open_basedir "/tmp/:{{SITE_ROOT}}/"
}
