#!/bin/sh
# Build the public website into dist-site/ (only the site's own files, never the PMS source).
set -e
cd "$(dirname "$0")/.."
rm -rf dist-site && mkdir -p dist-site
cp index.html services.html work.html how-we-work.html packages.html contact.html pms.html styles.css script.js dist-site/
cp -R images pms-demo dist-site/
find dist-site -name "README*" -delete
cat > dist-site/robots.txt <<'TXT'
User-agent: *
Allow: /
Sitemap: https://azelitech.com/sitemap.xml
TXT
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  for page in "" services.html pms.html work.html how-we-work.html packages.html contact.html; do
    echo "  <url><loc>https://azelitech.com/$page</loc></url>"
  done
  echo '</urlset>'
} > dist-site/sitemap.xml
echo "Website built in dist-site/ ($(find dist-site -type f | wc -l | tr -d ' ') files)"
