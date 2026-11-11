---
name: longform-camera-angles
description: Chọn góc quay, chuyển động camera và phông nền cho từng shot/chain của video long-form 16:9 "Science explained with humor" (Einstein và Newton) làm bằng MiniMax H3, sao cho nhiều góc, có lý do theo lời thoại và trò đùa. Dùng khi viết hoặc sửa bảng kịch bản và Storyboard của một tập, khi thêm địa điểm hoặc phông mới, và khi review góc quay. Gọi từ longform-minimax-h3-script-writer (bước chọn bối cảnh) và script-to-qwen-storyboard.
---

# Góc quay cho long-form (Einstein và Newton)

Đọc `video_production_with_skills/series/science_humor/series-bible.md` (vị trí đứng, ánh sáng) trước khi gán góc.

## Đơn vị
- **Chain** là một lượt render H3 liên tục, bắt đầu từ một keyframe K0. Trong chain camera chỉ đi liên tục: mỗi shot có tối đa **một** chuyển động, và vị trí camera cuối shot i là vị trí đầu shot i+1.
- **Setup** của chain = {địa điểm, góc, cỡ khung đầu} và quyết định phông và K0. **Chuyển động** gán cho từng shot.
- Đổi góc hay đổi vị trí máy là một cú cắt, tức là chain mới có K0 riêng. Mỗi chain mới tốn một K0 và một lượt khởi động H3, nên chỉ cắt khi có lý do ghi trong bảng.

## Danh mục góc

| Mã | Khung nhìn thấy | Dùng khi | Phông |
|---|---|---|---|
| `two-wide` | Cả hai từ đầu tới chân, thấy rõ phông | Mở cảnh, quay lại cảnh, giải thích dài | `front` |
| `two-medium` | Cả hai từ đùi trở lên | Hội thoại mặc định | `front` |
| `two-center` | Cả hai đối xứng quanh trục giữa khung, khung tĩnh | Hỏi đáp khô khan (deadpan) | `front` |
| `low-two` | Máy ngang đầu gối nhìn lên cả hai, vật lớn ở phông vươn cao | Phông có vật khổng lồ | `low` |
| `high-two` | Máy cao hơn đầu, nhìn xuống chừng 20°, hai người nhỏ trong phông | Cả hai bối rối hoặc đang khám phá | `high` |
| `low-newton` | Một mình Newton, máy thấp nhìn lên, cằm ngẩng | Newton tự mãn hoặc đắc thắng | `low` |
| `single-einstein`, `single-newton` | Một người, cỡ `medium` (từ đùi trở lên; push-in tới `close`), đứng ở một phần ba khung bên mình, quay ba phần tư về phía người ngoài khung | Ý chính, lời hứa, đòn kết | `front` |
| `ots-einstein`, `ots-newton` | Qua vai người gần máy, lấy nét vào người nói | Chưa dùng ở ep01 (sheet không có góc lưng) | `front` |
| `insert` | Cận một vật (quả táo, bút chì) | Chưa dùng ở ep01 (lời không có hình người) | `front` |

- Với góc một người, **người nói là người trong khung** (khớp môi). Người nghe ngoài khung chỉ thử sau khi nhóm đó được kiểm.
- Không dùng Dutch (nghiêng khung) trừ khi trò đùa nói về chóng mặt hay nghiêng.

## Chuyển động (tối đa một mỗi shot, viết bằng lời tự nhiên có điểm đến)

| Mã | Câu mẫu trong prompt | Dùng khi |
|---|---|---|
| `static` | "The camera holds this framing until the final frame." | Mặc định |
| `push-in` | "The camera moves straight in toward ⟨X⟩ until the framing is ⟨Y⟩." | Nhấn đòn kết hoặc ý chính; **chỉ ở góc một người** (khung hai người: xem dưới) |
| `pull-out` | "The camera moves straight back until the framing is ⟨wide⟩, revealing ⟨phông⟩." | Mở cảnh, đến địa điểm mới |
| `pan` | "The camera turns sideways to ⟨người kia⟩ and stops with ⟨họ⟩ centred." | Chuyển sự chú ý giữa hai người, chỉ ở khung `wide` khi cả hai vẫn trọn khung sau khi quay |
| `arc` | "The camera circles about twenty degrees to the ⟨side⟩ around the two men and stops." | Cú kéo hoặc đảo thế |

- **Hình học khung hai người:** hai người đứng ở hai phần ba trái/phải nên `push-in` quá khoảng 1,15 lần hoặc `pan` ở khung `medium` làm người ở rìa bị cắt: không dùng. `pull-out` làm hai người dịch về gần trục giữa khung (vẫn Einstein trái, Newton phải), nên các shot sau đó viết vị trí "gần trục giữa" thay vì "phần ba trái/phải". `arc` nhẹ (khoảng 20°) giữ được cả hai trong khung.
- Điểm cuối chuyển động (cỡ khung, ai ở giữa khung) viết rõ; không dùng "slowly" (từ cấm), thay bằng "smoothly at a steady pace".
- Không dùng handheld, whip pan, zoom nhanh, dolly-zoom.

## Chọn theo chức năng của đoạn lời

| Chức năng | Góc và chuyển động gợi ý |
|---|---|
| Mở bài, câu hỏi, lời hứa | `two-medium` kéo ra `two-wide` (`pull-out`) |
| Newton tự hào, tin chắc | `low-newton`, hoặc `single-newton` |
| Giải thích dài, hai bên nhường nhau | `two-medium` hoặc `two-wide`, `static` |
| Hỏi đáp ngắn, chốt ý khô khan | `two-center`, `static` |
| Cú kéo (twist) | `arc` hoặc `push-in` ở shot nêu cú kéo |
| Chuyển sự chú ý sang người kia | `pan` |
| Phông có vật khổng lồ hay địa điểm đáng ngắm | `low-two` hoặc `high-two` |
| Ý khoa học then chốt | `single` của người nói, có thể `push-in` |
| Lời cuối quay lại câu đầu tập | cùng góc với shot đầu tập (không đổi hướng kể) |

Mỗi shot ghi **lý do** (một cụm) trong bảng Storyboard.

## Nhịp và đa dạng
- Mỗi tập có **ít nhất 6 setup khác nhau** và **ít nhất 3 kiểu chuyển động** ngoài `static` (giá trị khởi điểm, chỉnh sau tập đầu).
- Hai chain liền nhau không cùng góc và cỡ khung đầu. Không quá 2 chain `low`/`high` liền nhau.
- Một người nói quá 2 shot liền thì đổi góc ở chain kế, không đổi giữa chain.
- Chuyển động chỉ khi có lý do theo bảng trên; không thêm cho "điện ảnh".

## Hướng màn hình (luật 180°)
- Einstein ở nửa trái khung và nhìn sang phải; Newton ở nửa phải và nhìn sang trái, ở mọi góc, kể cả góc một người (người trong khung giữ hướng nhìn của mình).
- Trục giữa hai người không đổi trong cùng địa điểm. Tay gần máy: Einstein dùng tay phải, Newton cầm táo tay trái.
- Qua cú cắt giữ nguyên tư thế, vật cầm và vị trí màn hình; chỉ góc, cỡ khung và phông đổi.

## Phông theo địa điểm và góc
- Mỗi (địa điểm, loại phông) cần một ảnh nền riêng, không người ở tiền cảnh, mặt đất phía trước để trống. Loại phông: `front` (ngang mắt), `low`, `high`. Tên trong `ep01/image_prompts.json`: `<địa điểm>` cho `front`, `<địa điểm>_low`, `<địa điểm>_high` cho hai loại còn lại.
- Phông phải khớp điều đang nói. Địa điểm bible chưa có mà lời cần thì **thêm địa điểm mới** (prompt phông kèm lý do) thay vì dùng lại phông cũ; đổi địa điểm bằng cú cắt kèm đoạn wormhole giữa hai chain.
- Phông chỉ là nền: không chữ, sơ đồ, công thức; nguy hiểm thật của địa điểm (thiếu không khí) phải được thoại đùa tới.

## Ràng buộc H3
- Một shot một sự kiện liên tục, không cắt giữa shot; shot kế tiếp nối từ khung cuối thật.
- Đổi góc trong cùng chain chưa được kiểm chứng: coi là cắt và chuyển sang chain mới.
- Chain giữ `reference_images` và `voice_refs` đủ hai người theo thứ tự cố định, kể cả khi góc một người chỉ có một người trong khung (`subject_definitions` chỉ nêu người trong khung).

## Trạng thái kiểm chứng (cập nhật sau mỗi lần chạy thử)
Chưa nhóm nào được chạy thử trên H3. Trước khi render cả tập, chạy thử một chain cho mỗi nhóm sau và ghi kết quả (mặt còn đúng, khớp môi, cú chuyển động ra đúng điểm cuối):
1. Chuyển động với hai người: `push-in`, `pull-out`, `pan`, `arc`.
2. Góc lạ: `low-two`, `high-two`, `low-newton`, `single-*`.
3. Cắt góc trong cùng chain (chỉ khi nhóm 1 và 2 đạt).

Nhóm không đạt thì thay bằng `two-medium` + `static` ở đúng chỗ đó.
