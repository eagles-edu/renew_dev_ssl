# Vhost Manager boilerplates

The manager renders every generated text file from this directory. Variables use
the `{{UPPER_SNAKE_CASE}}` form. The renderer fails if a variable is missing or
left unresolved; values are supplied by the reviewed site plan.

| File                                           | Generated output                                         | Main variables                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `nginx-production.conf.tpl`                    | `/etc/nginx/sites-available/<domain>.conf`               | domain names, webroot, certificate/key, upstream, logs, security, cache, MIME and optional global dependencies |
| `nginx-ssl-renewal.conf.tpl`                   | `/etc/nginx/sites-available/vhost_ssl/<domain>_ssl.conf` | domain names, webroot, upstream, logs                                                                          |
| `ols-main-vhost.conf.tpl`                      | OLS `virtualhost` block in `httpd_config.conf`           | vhost name and site root                                                                                       |
| `ols-vhost.conf.tpl`                           | `/usr/local/lsws/conf/vhosts/<domain>/vhconf.conf`       | domain, aliases, webroot, logs, PHP handler and identity                                                       |
| `php.ini.tpl`                                  | private per-site PHP ini                                 | selected profile contents and reviewed per-site directive overrides                                            |
| `placeholder.html.tpl`                         | initial `index.html`                                     | escaped site title                                                                                             |
| `robots-allow.txt.tpl`, `robots-block.txt.tpl` | `robots.txt`                                             | none                                                                                                           |
| `htaccess.tpl`                                 | optional OLS `.htaccess`                                 | domain                                                                                                         |

The SSL-renewal boilerplate serves ACME HTTP-01 files from the selected
webroot and proxies other requests only to the configured loopback OLS backend.
The production boilerplate is previewed as text and is not activated until a
certificate is available and the site operation is applied.
