#!/bin/sh
# Copies only runtime files into ./dist (what should go into the .wgt), with css/style.css inlined into
# dist/index.html so the first frame needs no extra file read.
#   sh tools/make-dist.sh && tizen package -t wgt -s <cert-profile> -- dist
#   tizen install -n dist/Home.wgt -t <device-serial>   (wgt name follows <name>)
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/data
cp -r config.xml icon.png CREDITS.md js images dist/
cp data/weekly.embed.js dist/data/
python3 - <<'PY'
import re
html = open('index.html').read()
css = open('css/style.css').read()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)                 # strip comments
css = re.sub(r'\n\s*\n+', '\n', css).strip()
tag = '<link rel="stylesheet" href="css/style.css"><!--RH:CSS-->'
assert tag in html, 'stylesheet marker missing'
open('dist/index.html', 'w').write(html.replace(tag, '<style>\n' + css + '\n</style>'))
PY
# API keys: injected into dist/js/config.js only, from the environment (never stored in the repo, never printed).
python3 - <<'PY'
import json, os, re
p = 'dist/js/config.js'; s = open(p).read(); used = []
for env, field in [('TMDB_API_KEY', 'tmdbApiKey'), ('TMDB_READ_TOKEN', 'tmdbReadToken'), ('OMDB_API_KEY', 'omdbApiKey'),
                   ('TRAKT_CLIENT_ID', 'traktClientId'), ('TRAKT_CLIENT_SECRET', 'traktClientSecret')]:
    v = os.environ.get(env, '').strip()
    if not v: continue
    s, n = re.subn(r"(\b" + field + r":\s*)''", lambda m: m.group(1) + json.dumps(v), s, count=1)
    if n: used.append(env)
tok = '.secrets/trakt-tokens.json'
if os.path.exists(tok):
    t = json.load(open(tok))
    for field, key in [('traktAccessToken', 'access_token'), ('traktRefreshToken', 'refresh_token')]:
        s = re.sub(r"(\b" + field + r":\s*)''", lambda m: m.group(1) + json.dumps(t.get(key, '')), s, count=1)
    for field, key in [('traktTokenCreatedAt', 'created_at'), ('traktTokenExpiresIn', 'expires_in')]:
        s = re.sub(r"(\b" + field + r":\s*)0\b", lambda m: m.group(1) + str(int(t.get(key, 0))), s, count=1)
    used.append('Trakt tokens (tools/trakt-link.sh)')
open(p, 'w').write(s)
print('keys injected into dist/js/config.js: ' + (', '.join(used) or 'none (offline snapshot mode)'))
PY
# Guard: the voice relay (Mac-side Node server) and secrets never go into the TV package.
for bad in relay .secrets tools mockups; do [ ! -e "dist/$bad" ] || { echo "make-dist: dist/$bad must not be packaged" >&2; exit 1; }; done
if find dist -name '*.env' -o -name 'trakt-tokens.json' -o -name 'mock-session.json' | grep -q .; then echo "make-dist: secret/dev file in dist" >&2; exit 1; fi
echo "dist/ ready ($(du -sh dist | cut -f1)):"; find dist -type f | sort | sed 's/^/  /'
echo "NOTE: dist/ now contains your API keys. Don't publish dist/ or the .wgt." 
