from PIL import Image, ImageDraw
from pathlib import Path
root = Path(__file__).resolve().parent.parent
im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((0, 0, 255, 255), radius=54, fill='#f2ecdf')
ink = '#996a4b'
d.arc((49, 53, 207, 235), 180, 360, fill=ink, width=15)
d.arc((80, 84, 176, 235), 180, 360, fill=ink, width=11)
d.line((30, 176, 226, 176), fill=ink, width=11)
d.line((36, 176, 36, 127, 52, 127, 52, 173), fill=ink, width=9)
d.line((204, 173, 204, 127, 220, 127, 220, 176), fill=ink, width=9)
for xy in [(68, 105, 84, 116), (96, 73, 105, 94), (150, 73, 145, 94), (185, 105, 170, 116)]:
    d.line(xy, fill=ink, width=7)
im.save(root / 'ui' / 'icon.png')
im.save(root / 'design' / 'app.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
