import asyncio, os, sys
from pathlib import Path
from novelvideo.generators.nanobanana_grid import _call_runpod_qwen21_render_image_api
S=Path(sys.argv[1])
prompt=("Convert <image1> into a real photograph, replacing the flat-colored mannequin figures and the plain backdrop with real people and a real location. "
"A tall man in a dark wool coat (the cyan figure) and a shorter woman in a red scarf and beige trench coat (the magenta figure) stand in a quiet stone-paved courtyard at dusk, "
"old brick wall behind them, a wooden crate on the right. Keep every figure's position, pose, size and the camera framing exactly as in <image1>. "
"Photorealistic cinematic photograph, natural soft evening light, shallow film grain.")
img=(S/"previs/previs_f0.png").read_bytes()
async def main():
    data,mime,err=await _call_runpod_qwen21_render_image_api(api_key=os.environ["RUNPOD_API_KEY"],model="qwen-image-2.1",prompt=prompt,
        reference_images=[("previs_f0.png",img,"image/png")],image_config={"aspect_ratio":"16:9","image_size":"1K"})
    print("err:",err,"mime:",mime,"bytes:",len(data or b""))
    if data: (S/"photo_f0.png").write_bytes(data)
asyncio.run(main())
