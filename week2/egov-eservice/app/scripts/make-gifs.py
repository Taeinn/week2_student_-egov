"""LAB 4: แปลงวิดีโอของ TC ระดับ P1 เป็น GIF · ใช้: cd test-report && python3 ../scripts/make-gifs.py /path/TEST-PLAN.md
ต้องรัน test ด้วย PW_VIDEO=1 และ -c playwright.report.config.ts ก่อน (วิดีโออยู่ใน test-report/artifacts)"""
import json,os,re,subprocess,glob,sys
P1=set(re.findall(r"^\| (TC-[A-Z]+-\d+) \|[^|]*\| P1",open(sys.argv[1],encoding="utf-8").read(),re.M))
titles=[]
def walk(s):
    for sp in s.get("specs",[]): titles.append(sp["title"])
    for c in s.get("suites",[]): walk(c)
for s in json.load(open("results.json",encoding="utf-8"))["suites"]: walk(s)
norm=lambda x: re.sub(r"[^0-9A-Za-z฀-๿]+","",x)
m={}
for d in os.listdir("artifacts"):   # ชื่อโฟลเดอร์ยาวถูกตัด + hash → จับคู่ด้วยท้ายชื่อ test
    if not glob.glob(f"artifacts/{d}/*.webm"): continue
    body=d[:-len("-chromium")]; h=re.search(r"-[0-9a-f]{5}-(.*)$",body)
    for t in titles:
        tc=re.match(r"TC-[A-Z]+-\d+",t).group(0)
        if (h and norm(t).endswith(norm(h.group(1)))) or (not h and norm(body).endswith(norm(t))): m[tc]=d
os.makedirs("gif",exist_ok=True); miss=[]
for tc in sorted(P1):
    if tc not in m: miss.append(tc); continue
    v=max(glob.glob(f"artifacts/{m[tc]}/*.webm"),key=os.path.getsize)
    subprocess.run(["ffmpeg","-loglevel","error","-y","-i",v,"-vf","fps=4,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse",f"gif/{tc}.gif"],check=True)
print("P1",len(P1),"gif",len(P1)-len(miss),"missing",miss)