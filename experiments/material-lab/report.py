"""Verify the captures and assemble measured before/after comparison artifacts."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import json, hashlib, statistics, html

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
OUT=ROOT/'output/playwright/material-lab'
data=json.loads((OUT/'benchmark.json').read_text())
prepared=json.loads((HERE/'assets/prepared.json').read_text())
assert not data['errors'],data['errors']
assert len(data['runs'])==24, 'Incomplete benchmark'
for r in data['runs']:
    assert r['gpuMs']['samples']==96 and not r['disjointRejected'] and not r['pendingExpired'],r
for path,digest in prepared['originalAssets'].items():
    assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==digest,path+' was modified'

summary={'resolution':data['resolution'],'renderer':data['runs'][0]['renderer'],'browser':data['browser'],
         'method':data['method'],'scenes':{},'originalAssetsUnchanged':True,'shaderErrors':len(data['errors'])}
for scene in ['luxor','sento']:
    rows=[]
    for pose in ['close','wide','grazing']:
        row={'view':pose}
        for variant in ['before','after']:
            rr=[r for r in data['runs'] if r['scene']==scene and r['pose']==pose and r['variant']==variant]
            row[variant]={'gpuMedianMs':statistics.mean(r['gpuMs']['median'] for r in rr),
                          'gpuP95Ms':max(r['gpuMs']['p95'] for r in rr),
                          'runMedianRangeMs':[min(r['gpuMs']['median'] for r in rr),max(r['gpuMs']['median'] for r in rr)],
                          'cpuMedianMs':statistics.mean(r['cpuSubmitMs']['median'] for r in rr),
                          'textureMiB':rr[0]['memory']['textureBytes']/1048576,
                          'detailMiB':rr[0]['memory']['detailBytes']/1048576,
                          'drawCalls':rr[0]['drawCalls'],'triangles':rr[0]['triangles'],'samples':sum(r['gpuMs']['samples'] for r in rr)}
        pr=[r for r in data['paired'] if r['scene']==scene and r['pose']==pose]
        row['pairedMedianDeltaMs']=statistics.mean(r['pairedDeltaMs']['median'] for r in pr)
        row['pairedDeltaRunRangeMs']=[min(r['pairedDeltaMs']['median'] for r in pr),max(r['pairedDeltaMs']['median'] for r in pr)]
        row['gpuDeltaMs']=row['after']['gpuMedianMs']-row['before']['gpuMedianMs']
        row['gpuDeltaPercent']=100*row['gpuDeltaMs']/row['before']['gpuMedianMs']
        rows.append(row)
    a,b,mask=[np.asarray(Image.open(OUT/f'{scene}-{name}.png').convert('RGB'),np.int16)
              for name in ['albedo-before','albedo-after','protected-pixels']]
    m=np.min(mask,axis=-1)>150
    assert m.sum()>100,scene+' has too few protected pixels'
    difference=np.abs(a-b)
    error=int(difference[m].max())
    assert error==0,f'{scene} protected albedo changed by {error}'
    summary['scenes'][scene]={'views':rows,'preservation':{'protectedPixels':int(m.sum()),'maxAlbedoByteError':error,
        'note':'Compared rendered albedo with the detail layer disabled/enabled on exactly the protected visible pixels. This checks the mask, not semantic completeness of automatic detection.'}}

(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
(HERE/'assets/summary.json').write_text(json.dumps(summary,indent=2)+'\n')

def timing_range(row):
    a,b=row['runMedianRangeMs']
    return f'{a:.2f}–{b:.2f}'

def font(size):
    for p in ['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if Path(p).exists(): return ImageFont.truetype(p,size)
    return ImageFont.load_default(size=size)

for scene,title in [('luxor','Luxor · sandstone wall'),('sento','Sento · ceramic floor')]:
    info=summary['scenes'][scene]['views'][0]
    pair=[Image.open(OUT/f'{scene}-close-{mode}.png').convert('RGB') for mode in ['before','after']]
    board=Image.new('RGB',(1920,664),'#101713');draw=ImageDraw.Draw(board)
    draw.text((28,18),title,font=font(25),fill='#e7efe9')
    detail=f"GPU {timing_range(info['before'])} → {timing_range(info['after'])} ms  ·  +{info['after']['detailMiB']:.2f} MiB"
    draw.text((1030,23),detail,font=font(19),fill='#afc9b7')
    for k,im in enumerate(pair):
        draw.text((28+k*960,62),'BEFORE · original exported maps' if k==0 else 'AFTER · exemplar detail + aligned material maps',font=font(17),fill='#cbd9cf')
        board.paste(im.resize((960,540),Image.Resampling.LANCZOS),(k*960,92))
    draw.text((28,641),'Matched camera, light and exposure · 1280 × 720 · Apple M1 / Chrome · GPU ranges show two run medians; timings provisional',font=font(14),fill='#92a99b')
    board.save(OUT/f'{scene}-comparison.png')
    # Native-pixel crops are useful because the sandstone change is deliberately small.
    box=(100,280,660,680) if scene=='luxor' else (320,320,880,720)
    crop=Image.new('RGB',(1120,444),'#101713');d=ImageDraw.Draw(crop)
    for k,im in enumerate(pair):
        d.text((16+k*560,10),'Before · native pixels' if k==0 else 'After · native pixels',font=font(18),fill='#cbd9cf')
        crop.paste(im.crop(box),(k*560,44))
    crop.save(OUT/f'{scene}-detail-comparison.png')

table=''
for scene in ['luxor','sento']:
    for r in summary['scenes'][scene]['views']:
        a,b=r['before'],r['after']
        table+=f"<tr><td>{scene.title()}</td><td>{r['view']}</td><td>{timing_range(a)}</td><td>{timing_range(b)}</td><td>{r['pairedDeltaRunRangeMs'][0]:+.3f} to {r['pairedDeltaRunRangeMs'][1]:+.3f}</td><td>{a['textureMiB']:.2f} → {b['textureMiB']:.2f}</td></tr>"
cards=''
for scene in ['luxor','sento']:
    p=summary['scenes'][scene]['preservation']
    cards+=f'''<section><h2>{scene.title()}</h2><img src="{scene}-comparison.png" alt="{scene} before and after"><p><a href="{scene}-detail-comparison.png">Native-pixel detail crop</a> · <a href="{scene}-wide-after.png">Context</a> · <a href="{scene}-grazing-after.png">Grazing angle</a> · <a href="{scene}-preservation-overlay.png">Preservation mask</a> · <a href="{scene}-relit-after.png">Changed light</a></p><p>{p['protectedPixels']:,} protected visible pixels: zero albedo difference.</p></section>'''
page=f'''<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trompe material prototype — measurements</title><style>body{{font:16px/1.6 system-ui;max-width:1440px;margin:36px auto;padding:0 24px;background:#101713;color:#deebe2}}h1,h2{{font-weight:500}}p{{max-width:950px;color:#b4c8ba}}a{{color:#bfe6c8}}img{{width:100%;border:1px solid #344a3b}}table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #344a3b}}small{{color:#9db6a5}}section{{margin:48px 0}}</style><h1>Trompe · material prototype</h1><p>Two controlled material studies on the original Luxor wall and Sento floor. Original atlas images and UVs remain unchanged. Fine material fields are sampled at fixed world scale, with one coordinate transform shared by colour detail, height and roughness; added normals come from the height gradient.</p><p><a href="http://localhost:5178/experiments/material-lab/">Open the interactive wipe comparison</a> · <a href="benchmark.json">Raw measurements</a> · <a href="summary.json">Validation summary</a></p>{cards}<h2>Rendering cost</h2><p>1280 × 720, Apple M1, Chrome {html.escape(data['browser'])}. Two independent contexts per scene, 192 GPU samples per variant and view. Before/after renders occupy adjacent animation frames, alternating AB/BA order. GPU completion is synchronized outside each timed query to isolate deferred work on the tile-based GPU. The table shows the range of the two run medians and the two median paired deltas. Absolute times varied substantially, so treat these as provisional measurements and repeat on an idle target device before setting a performance budget. A difference between two separate medians need not equal the median of paired differences. Raw query samples are included. GPU timing queries measure scene rendering; these values are not total game frame times or FPS. Static shadow maps are cached.</p><table><thead><tr><th>Scene</th><th>View</th><th>Before GPU ms</th><th>After GPU ms</th><th>Paired added GPU ms</th><th>Required texture MiB</th></tr></thead><tbody>{table}</tbody></table><p>Memory is an estimate of required texture payload from dimensions, formats and mip levels, including the environment and colour shadow texture. It excludes browser/compositor buffers, depth renderbuffers and driver overhead. Both materials are resident during paired timing; the baseline figure excludes unused detail assets. It is not a hardware VRAM counter. The baseline intentionally retains the existing scene assets.</p><h2>What this establishes</h2><p>The floor benefits strongly from restoring the existing 1024 px/metre tile exemplar above the baked atlas's detail limit. Its source tile boundaries and original broad colour/stains stay in place. The wall receives restrained, non-repeating stone grain around protected paint; this does not recover blurry inscriptions. All original input-asset hashes are unchanged; both scenes compile with no shader errors.</p><h2>Limits</h2><p>PATINA height is inferred, not measured. The 1.2 mm sandstone span, 2 mm tile/grout span and material roughness levels are artist-selected. Preservation masks are conservative heuristics and still need review. The comparison uses exported PBR materials under identical evaluation lighting, not the complete Luxor film/weather/POM viewer. This is a small exemplar-synthesis prototype, not a full implementation of MeshNCA or the paper's filtering algorithm. The floor uses identified tile regions for a small, deterministic local-mean exchange; the stone blends three correlated samples. Exporting these runtime effects as plain glTF would require a bake or custom shader support.</p><small>{html.escape(summary['renderer'])}</small></html>'''
(OUT/'comparisons.html').write_text(page)
print('Validated 24 timing series, 12 paired series, unchanged source assets, and zero protected albedo differences.')
for scene,info in summary['scenes'].items():
    close=info['views'][0]
    print(f"{scene}: GPU {timing_range(close['before'])} → {timing_range(close['after'])} ms; +{close['after']['detailMiB']:.2f} MiB; {info['preservation']['protectedPixels']:,} protected pixels")
