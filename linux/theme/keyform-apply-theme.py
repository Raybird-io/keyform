#!/usr/bin/env python3
"""
Puts your desktop theme's colours into Keyform.

matugen writes keyform-theme.css next to keyform.html whenever your theme changes, then runs
this script. It copies those colours into keyform.html itself (inside <style id="keyform-theme">),
so they work in every browser, including Flatpak browsers that can only open the one file.

Usage: keyform-apply-theme [folder]     (default folder: ~/Keyform)
"""
import os, re, sys, tempfile

folder = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Keyform')
html_path = os.path.join(folder, 'keyform.html')
css_path = os.path.join(folder, 'keyform-theme.css')

try:
    html = open(html_path, encoding='utf-8').read()
except FileNotFoundError:
    sys.exit(f'keyform-apply-theme: {html_path} not found')
css = open(css_path, encoding='utf-8').read() if os.path.exists(css_path) else ''
css = css.replace('</style', '')  # never close the tag early

marker = re.compile(r'(<style id="keyform-theme">)[\s\S]*?(</style>)')
if not marker.search(html):
    sys.exit('keyform-apply-theme: this keyform.html has no theme slot; run ./linux/install.sh to update it')
new = marker.sub(lambda m: m.group(1) + css + m.group(2), html, count=1)
if new != html:
    fd, tmp = tempfile.mkstemp(dir=folder, prefix='.keyform-', suffix='.html')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(new)
    os.chmod(tmp, 0o644)
    os.replace(tmp, html_path)  # swap in one step, so the file is never half-written
print('Keyform theme', 'applied' if css else 'cleared (built-in colours)')
