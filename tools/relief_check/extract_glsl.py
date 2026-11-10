#!/usr/bin/env python3
# Pull C string-literal shader sources out of the port's renderer files -> a JS module.
import json, re, sys
root = sys.argv[1]
src = open(root + '/platform/render/gl_renderer.c').read() + open(root + '/platform/render/relief_glsl.h').read()
defs = dict(re.findall(r'#define (RELIEF_\w+) (\d+)', src))
def lit(name):
    m = re.search(r'static const char \*' + name + r'\s*=\s*(.*?);\n', src, re.S)
    body = m.group(1)
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    body = re.sub(r'RELIEF_STR\((\w+)\)', lambda k: '"%s"' % defs[k.group(1)], body)
    out = ''
    for s in re.findall(r'"((?:[^"\\]|\\.)*)"', body):
        out += s.encode().decode('unicode_escape')
    return out
names = ['kCommon', 'kCompVs', 'kRelCommon', 'kRel1Fs', 'kRel2Fs', 'kRel3Fs', 'kRel4Fs', 'kRel5Fs']
print('export const S = ' + json.dumps({n: lit(n) for n in names}, indent=1) + ';')
print('export const MARGIN = %s;' % defs['RELIEF_MARGIN'])
