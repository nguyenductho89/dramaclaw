# Newton POV: YouTube Short 9:16, ~60s

**Lời đọc:** tiếng Anh, Newton ngôi thứ nhất, do H3 tự sinh, thong thả, accent Anh. Âm sắc được ghim bằng một clip mẫu từ Qwen3-TTS VoiceDesign (`voice_ref`), xem `previs_h3_test/scripts/qwen_voice_design.py`. **Góc máy:** camera là mắt Newton, chỉ thấy tay và tay áo. Trong hình không ai nói.

**Cấu trúc:** 4 chain × 2 shot × 192 khung (8,0 s), checkpoint ref2va, turbo LoRA 12 bước. Mỗi chain có một keyframe Qwen làm `start_image` và dùng chung một `voice_ref`; giữa các chain là hard cut. Prompt: `previs_h3_test/scripts/skits/newton_pov/chain_0N.json`.

| Chain | Thời kỳ | Hình | Shot | Lời đọc |
|---|---|---|---|---|
| 1 | 1727, về già | Tay già cầm cốc thiếc trước lò sưởi, rồi đặt xuống bàn | 1 | Born so small, I fit a quart pot. I am Isaac Newton. |
| | | | 2 | No one expected me to live a day. |
| 2 | 1665, dịch hạch | Tay trẻ dính mực, sổ trắng, vườn táo; táo rơi xuống cỏ | 1 | Sixteen sixty-five. Plague shut Cambridge. I went home. |
| | | | 2 | An apple fell, not on my head. Why straight down? |
| 3 | Thập niên 1660, ánh sáng | Phòng tối, tia nắng, lăng kính tách cầu vồng; tay kia giơ cây kim | 1 | I split sunlight with a prism. White was never white. |
| | | | 2 | I even pushed a needle behind my eye. |
| 4 | Về già, bờ biển | Gấp sách, thả khỏi khung; nhặt viên sỏi, xoè tay trước biển | 1 | I wrote the laws that move the planets. And yet... |
| | | | 2 | A boy with a pebble. The ocean, unexplored. |

## Phép tính thoại (giới hạn ≤ 3 âm tiết/giây)
| Chain.shot | Âm tiết | Cửa sổ | Âm tiết/giây | Dư cuối shot |
|---|---|---|---|---|
| 1.1 | 15 | 1,0–6,5 s | 2,73 | 1,5 s |
| 1.2 | 10 | 2,0–6,5 s | 2,22 | 1,5 s |
| 2.1 | 12 | 1,0–6,5 s | 2,18 | 1,5 s |
| 2.2 | 11 | 2,0–6,5 s | 2,44 | 1,5 s |
| 3.1 | 13 | 1,5–6,5 s | 2,60 | 1,5 s |
| 3.2 | 11 | 2,0–6,5 s | 2,44 | 1,5 s |
| 4.1 | 11 | 1,0–6,5 s | 2,00 | 1,5 s |
| 4.2 | 12 | 2,0–6,5 s | 2,67 | 1,5 s |

Shot 2 của mỗi chain chỉ bắt đầu nói từ giây 2,0, theo quy tắc airlock của pack `ComfyUI-H3-Multishot`.

## Thời lượng
Mỗi chain 383 khung (15,96 s), tổng khoảng 63,8 s. Cắt bớt phần giữ khung ở cuối mỗi chain khi dựng để còn khoảng 60 s.

## Ghi chú kiểm chứng
- **Cốc quart:** [DSB](https://mathshistory.st-andrews.ac.uk/DSB/Newton.pdf) ghi Newton kể mình lọt vừa cốc quart lúc sinh; các nguồn khác gán lời này cho mẹ ông hoặc [Conduitt](https://mentalfloss.com/article/81487/15-observational-facts-about-isaac-newton). Chi tiết có thật ở mức giai thoại gia đình, nguồn gốc chưa rõ.
- **Không sống nổi một ngày:** ông sinh non và [người nhà lo cho tính mạng](https://mathshistory.st-andrews.ac.uk/DSB/Newton.pdf). "A day" là cách nói của lời đọc, không phải trích dẫn.
- **Năm 1665, dịch hạch:** [Cambridge đóng cửa năm 1665](https://history.com/articles/did-an-apple-really-fall-on-isaac-newtons-head); nguồn có chênh lệch 1665 và 1666.
- **Quả táo:** câu chuyện đến từ [hồi ký Stukeley](https://www.lindahall.org/about/news/scientist-of-the-day/isaac-newton-4/) (1726), [không có chi tiết táo rơi trúng đầu](https://history.howstuffworks.com/history-vs-myth/isaac-newton-apple.htm).
- **Cây kim sau mắt:** [sổ tay MS Add. 3975, trang 15](https://exhibitions.lib.cam.ac.uk/linesofthought/?p=140), Thư viện Đại học Cambridge. Niên đại ghi lệch nhau (1665–66 hoặc khoảng 1669), nên chain 3 chỉ ghi "1660s". Hình chỉ cho thấy tay giơ cây kim xa mặt, không quay cảnh ấn vào mắt.
- **Viên sỏi và đại dương:** lời kể gián tiếp qua [Spence, *Anecdotes* (dẫn lời Ramsay)](https://todayinsci.com/N/Newton_Isaac/NewtonIsaac-PlayingOnTheSeashore.htm), không có bản ghi trực tiếp. Lời đọc diễn đạt lại, không phải trích dẫn.
- **Accent:** chỉ yêu cầu được "accent Anh". Giọng Lincolnshire thế kỷ 17 thật của Newton không có bản ghi, nên không thể đòi đúng tuyệt đối.
