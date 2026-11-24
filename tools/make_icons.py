import sys, math
from PIL import Image, ImageDraw
out = sys.argv[1]

def bez(p0, p1, p2, p3, n=80):
    pts = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        pts.append((u**3*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t**3*p3[0], u**3*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t**3*p3[1]))
    return pts

def make(size, maskable=False):
    S = 1024
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 背景：深色渐变（模拟夜间卫星图）
    bg = Image.new('RGBA', (S, S))
    bd = ImageDraw.Draw(bg)
    for y in range(S):
        f = y / S
        bd.line([(0, y), (S, y)], fill=(int(18 + 10 * f), int(32 + 12 * f), int(38 + 8 * f), 255))
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    if maskable: md.rectangle([0, 0, S, S], fill=255)
    else: md.rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=255)
    im.paste(bg, (0, 0), mask)
    sc = 0.72 if maskable else 1.0
    o = (1 - sc) * S / 2
    P = lambda x, y: (o + x * sc, o + y * sc)
    path = bez(P(210, 800), P(330, 520), P(700, 760), P(620, 480)) + bez(P(620, 480), P(560, 270), P(760, 260), P(820, 210))
    # 描边阴影
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0)); sd = ImageDraw.Draw(sh)
    for (x, y) in path:
        r = 50 * sc; sd.ellipse([x - r, y - r, x + r, y + r], fill=(0, 0, 0, 120))
    im.alpha_composite(sh)
    # 渐变线（蓝→绿→黄→橙）
    stops = [(64, 120, 255), (25, 211, 230), (61, 220, 74), (255, 210, 31), (255, 140, 26)]
    n = len(path)
    for i in range(n - 1):
        f = i / (n - 1) * (len(stops) - 1); k = min(int(f), len(stops) - 2); g = f - k
        c = tuple(int(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * g) for j in range(3))
        d.line([path[i], path[i + 1]], fill=c + (255,), width=int(62 * sc))
        r = 31 * sc; d.ellipse([path[i][0] - r, path[i][1] - r, path[i][0] + r, path[i][1] + r], fill=c + (255,))
    s, e = path[0], path[-1]
    for (x, y), col in ((s, (34, 197, 94)), (e, (255, 255, 255))):
        R = 58 * sc; d.ellipse([x - R, y - R, x + R, y + R], fill=(255, 255, 255, 255))
        R = 36 * sc; d.ellipse([x - R, y - R, x + R, y + R], fill=col + (255,) if col != (255, 255, 255) else (255, 90, 95, 255))
    return im.resize((size, size), Image.LANCZOS)

make(192).save(out + '/icon-192.png')
make(512).save(out + '/icon-512.png')
make(512, True).save(out + '/icon-maskable.png')
print('ok')
