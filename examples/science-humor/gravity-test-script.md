# What is gravity, really? (bản thử)
Tổng: 1:04.0, 76 từ. Barnaby 36 từ, Ambrose 40 từ.

Bản thử không có mở đầu và lời hứa theo khuôn tập dài: mục tiêu là kiểm hình, khớp môi, hai giọng, độ hài và cú cắt sang bối cảnh mới. File này viết bằng skill `longform-minimax-h3-script-writer`; mục Storyboard viết bằng skill `script-to-qwen-storyboard`.

| Mốc | Chain, shot | Bối cảnh | Người nói | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|---|
| 0:00.0-0:08.0 | 01, 1 | Vườn Địa Đàng | Ambrose | The Earth pulls the apple down. Newton settled this. | Ambrose tưởng đã xong chuyện | S2 |
| 0:08.0-0:16.0 | 01, 2 | Vườn Địa Đàng | Barnaby | Nice. But to Einstein, gravity isn't a pull. | Một câu làm hỏng cả vườn táo | S2 |
| 0:16.0-0:24.0 | 01, 3 | Vườn Địa Đàng | Ambrose | Not a pull? Newton's laws still work for a great many things. |  | S3 |
| 0:24.0-0:32.0 | 01, 4 | Vườn Địa Đàng | Barnaby | Sure. But mass bends spacetime. The apple just takes the straightest path. | Nghe vô lý mà đúng trong lý thuyết | S2 |
| 0:32.0-0:40.0 | 02, 1 | Mặt Trăng (bãi đáp Apollo 11) | Ambrose | Where is the orchard? And why am I on the Moon? | Ambrose rơi xuống Mặt Trăng từ từ vì trọng lực yếu, Barnaby thấy bình thường (đúng tính cách lạc giữa bối cảnh) |  |
| 0:40.0-0:48.0 | 02, 2 | Mặt Trăng (bãi đáp Apollo 11) | Barnaby | Better view. Also, there's no air, so talk fast. | Đùa về việc không có không khí, dựng sẵn cho câu sau | S1 |
| 0:48.0-0:56.0 | 02, 3 | Mặt Trăng (bãi đáp Apollo 11) | Barnaby | Apollo Fifteen: hammer and feather, landed together. |  | S1 |
| 0:56.0-1:04.0 | 02, 4 | Mặt Trăng (bãi đáp Apollo 11) | Ambrose | Of course. Galileo told you so. You're welcome. | Ambrose giành công cho khoa học cổ điển | S1 |

## Nguồn

- S1: NASA, [The Apollo 15 Hammer-Feather Drop](https://science.nasa.gov/resource/the-apollo-15-hammer-feather-drop/); NSSDC, [Apollo 15 Hammer-Feather Drop](https://nssdc.gsfc.nasa.gov/planetary/lunar/apollo_15_feather_drop.html). Đã đọc. Dùng cho: David Scott của Apollo 15 thả búa và lông vũ gần như trong chân không, chạm đất cùng lúc, đúng như Galileo đã kết luận.
- S2: Einstein Online, [Gravity: from weightlessness to curvature](https://www.einstein-online.info/en/spotlight/geometry_force/). Đã đọc. Dùng cho: thuyết của Newton coi hấp dẫn là lực; trong thuyết của Einstein, khối lượng làm cong không-thời gian, vật rơi đi theo đường "as straight as possible", và lực hấp dẫn khi rơi tự do "in part, an illusion". Vì vậy lời thoại ghi rõ "in Einstein's theory".
- S3: NASA, [Orbits and Kepler's Laws](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/). Đã đọc. Dùng cho: định luật Newton "still accurate enough for many applications". Trang này cũng nói bay vũ trụ chính xác cần tính thuyết tương đối, nên không dùng nó cho câu kiểu "Newton vẫn đủ để bay vũ trụ".

"Newton settled this" là lời tự hào của Ambrose, được Barnaby phản bác ngay sau đó, không phải kết luận của kênh. "To Einstein, gravity isn't a pull" là cách nói gọn: S2 nói lực hấp dẫn khi rơi tự do "in part, an illusion". "Hammer and feather, landed together" trên Mặt Trăng chỉ thể hiện kết quả; Ambrose không nêu kiến thức hiện đại.

## Tính lại

Không có con số tính ra. Tốc độ thoại theo prompt: cao nhất 2.83 âm tiết/giây (câu kết thúc ở 6.30 s, shot dài 8 s). Ở bài thử ep01 H3 đọc một câu 14 âm tiết trong khoảng 3,3 s, nhanh hơn prompt, nên phải nghe lại sau khi sinh.

## Cần người bản ngữ đọc

- "Nice. But to Einstein, gravity isn't a pull."
- "Not a pull? Newton's laws still work for a great many things."
- "Sure. But mass bends spacetime. The apple just takes the straightest path."
- "Better view. Also, there's no air, so talk fast."
- "Apollo Fifteen: hammer and feather, landed together."
- "Of course. Galileo told you so. You're welcome."

## Storyboard

Viết bằng skill `script-to-qwen-storyboard` từ bảng kịch bản ở trên và `series-bible.md`.

**Chung**
- Ảnh nền: cảnh 01 `previs_h3_test/scripts/skits/science_humor/gravity_test/backgrounds/orchard.png`; cảnh 02 `previs_h3_test/scripts/skits/science_humor/gravity_test/backgrounds/moon.png`. (bible, mục Bối cảnh)
- Ảnh tham chiếu nhân vật, theo thứ tự cố định cho mọi keyframe: (1) Barnaby `previs_h3_test/scripts/skits/science_humor/character/barnaby_sheet.png`, (2) Ambrose `previs_h3_test/scripts/skits/science_humor/character/ambrose_sheet.png`. (bible, mục Nhân vật)
- Vị trí: Barnaby ở phần ba bên trái, Ambrose ở phần ba bên phải, cùng cỡ và cùng độ sâu, quay ba phần tư về phía nhau và về phía máy. Không đổi chỗ. (bible, mục Bối cảnh)
- Vật cầm: Ambrose luôn cầm một quả táo đỏ bằng tay trái; Barnaby không cầm gì. (bible, mục Nhân vật: Ambrose)
- Vật nền phải giữ: cảnh 01 cây táo, hai bóng người nhỏ ở xa; cảnh 02 mô-đun đổ bộ, Trái Đất nhỏ, phi hành gia và cờ ở xa. (ảnh nền; bible, mục Bối cảnh)
- Cỡ khung: `wide` = thấy trọn từ đầu tới chân; `medium` = từ giữa đùi trở lên; `close` = từ dưới eo trở lên. (cỡ khung "toàn thân" theo bible, mục Bối cảnh; hai cỡ gần hơn do skill đặt để nhấn nội dung)

**Bảng shot** (tư thế đầu shot i+1 bằng tư thế cuối shot i; cỡ khung đầu shot i+1 bằng cỡ khung cuối shot i)

| Cảnh, shot | Người nói, lời | Tư thế đầu shot | Tư thế cuối shot | Vật cầm | Cỡ khung đầu | Cỡ khung cuối | Căn cứ |
|---|---|---|---|---|---|---|---|
| 01, 1 | Ambrose: "The Earth pulls the apple down. Newton settled this." | Cả hai đứng sẵn: Barnaby tay trong túi áo, thoải mái; Ambrose cầm táo | Ambrose giơ quả táo lên, ngẩng cằm đắc thắng; Barnaby lắng nghe, tay trong túi | Ambrose cầm táo tay trái | wide | wide | Trò đùa: "Ambrose tưởng đã xong chuyện"; bible: Barnaby "thoải mái" |
| 01, 2 | Barnaby: "Nice. But to Einstein, gravity isn't a pull." | Như cuối shot 01,1 | Barnaby chỉ vào quả táo; Ambrose nhìn Barnaby, chau mày | Ambrose cầm táo tay trái | wide | medium | Trò đùa: "Một câu làm hỏng cả vườn táo" |
| 01, 3 | Ambrose: "Not a pull? Newton's laws still work for a great many things." | Như cuối shot 01,2 | Ambrose giơ một ngón tay phản đối; Barnaby nghiêng đầu lắng nghe | Ambrose cầm táo tay trái | medium | medium | Lời của Ambrose; bible: Barnaby "thua cãi mà vẫn vui" |
| 01, 4 | Barnaby: "Sure. But mass bends spacetime. The apple just takes the straightest path." | Như cuối shot 01,3 | Barnaby đưa bàn tay phải duỗi phẳng ngang eo; Ambrose nhìn xuống quả táo | Ambrose cầm táo tay trái | medium | close | Trò đùa: "Nghe vô lý mà đúng trong lý thuyết"; lời nói về "straightest path" |
| 02, 1 | Ambrose: "Where is the orchard? And why am I on the Moon?" | Cả hai đứng sẵn: Barnaby tay trong túi áo, nhìn quanh; Ambrose ôm quả táo vào ngực | Ambrose giơ tay phải ngửa lòng bàn tay, nhìn Barnaby, bối rối; Barnaby nhìn quanh thản nhiên, tay trong túi | Ambrose ôm táo vào ngực bằng tay trái | wide | wide | Trò đùa: Ambrose rơi xuống từ từ, Barnaby thấy bình thường; bible: Barnaby "đãng trí" |
| 02, 2 | Barnaby: "Better view. Also, there's no air, so talk fast." | Như cuối shot 02,1 | Barnaby đứng thản nhiên, tay trong túi, quay về phía Ambrose; Ambrose mở to mắt nhìn Barnaby | Ambrose ôm táo vào ngực | wide | wide | Trò đùa: "Đùa về việc không có không khí" |
| 02, 3 | Barnaby: "Apollo Fifteen: hammer and feather, landed together." | Như cuối shot 02,2 | Barnaby chỉ xuống mặt đất; Ambrose nhìn xuống đất | Ambrose ôm táo vào ngực | wide | medium | Lời nói về búa và lông vũ rơi |
| 02, 4 | Ambrose: "Of course. Galileo told you so. You're welcome." | Như cuối shot 02,3 | Ambrose ngẩng cằm cao, giơ quả táo lên ngang vai đắc ý; Barnaby nhướn lông mày nhìn Ambrose | Ambrose giơ táo bằng tay trái | medium | medium | Trò đùa: "Ambrose giành công cho khoa học cổ điển"; bible: Ambrose "luôn giành phần công" |

**Kiểm tra liền mạch:** mọi cặp shot liên tiếp trong cùng cảnh khớp (tư thế, cỡ khung, vật cầm, vị trí); không shot nào bắt đầu ở cỡ khung rộng hơn cỡ khung kết thúc của shot trước.
