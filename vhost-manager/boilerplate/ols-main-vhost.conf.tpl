virtualhost {{VHOST_NAME}} {
  vhRoot {{VH_ROOT}}
  configFile conf/vhosts/{{VHOST_NAME}}/vhconf.conf
  allowSymbolLink 1
  enableScript 1
  restrained 1
}
