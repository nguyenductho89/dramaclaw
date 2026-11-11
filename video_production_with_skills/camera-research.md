# Tài liệu góc quay: nguồn cho skill `longform-camera-angles`

Tra cứu ngày 2026-11-11 bằng tìm kiếm web. Phần lớn là bài viết của bên thứ ba; chưa đọc hướng dẫn chính thức của MiniMax cho H3. Mục "Chưa xác nhận" là việc phải kiểm trên H3 trước khi tin.

## Hội thoại: shot-reverse-shot, qua vai, luật 180°
- Shot-reverse-shot là kiểu dựng; qua vai là cỡ khung. Có thể dựng từ qua vai, từ khung một người, hoặc trộn. Luật 180°: mọi máy ở một phía của trục giữa hai nhân vật, nếu không họ đổi bên màn hình. Nên có một khung hai người rộng cộng hai góc ngược chiều.
  - Adobe, [What is the 180 degree rule](https://www.adobe.com/creativecloud/video/discover/what-is-the-180-degree-rule.html)
  - Adobe, [Reverse shot](https://www.adobe.com/creativecloud/video/production/cinematography/camera-shots-and-angles/reverse-shot.html)
  - Videomaker, [How to Shoot Dialogue Scenes](https://www.videomaker.com/article/c06/17657-how-to-shoot-dialogue-scenes/)
  - Backstage, [What Is a Shot-Reverse Shot?](https://www.backstage.com/magazine/article/what-is-shot-reverse-shot-film-examples-75550/)
  - How To Film School, [Shot Reverse Shot](https://howtofilmschool.com/dictionary/shot-reverse-shot/)
  - Frame.io, [When to break the 180-degree rule](https://blog.frame.io/?p=917)

## Ý nghĩa của góc
- Góc thấp gợi quyền lực và tự tin; góc cao gợi yếu thế hoặc giúp định vị bối cảnh; Dutch gợi bất an; lạm dụng thì mất tác dụng.
  - Videomaker, [All About Camera Angles](https://www.videomaker.com/article/f5/9128-all-about-camera-angles)
  - Soundstripe, [Understanding shot angles and levels](https://soundstripe.com/blogs/understanding-shot-angles-and-levels)

## Hài
- Reaction shot gần làm câu đá xoáy "đáp" xuống: DGA Quarterly, [Critic's Corner, Dave Kehr](https://www.dga.org/craft/dgaq/issues/0902-summer-2009/critics-corner-dave-kehr).
- Khung hai người mang chất deadpan: David Bordwell, [Where did the two-shot go?](https://www.davidbordwell.net/blog/2013/10/07/where-did-the-two-shot-go-here/).
- Đối xứng chính diện và cắt hoặc lia giữa hai khung cố định kiểu Wes Anderson: StudioBinder, [Wes Anderson symmetry](https://www.studiobinder.com/blog/wes-anderson-symmetry/); Backstage, [Wes Anderson's filmmaking style](https://www.backstage.com/magazine/article/wes-anderson-filmmaking-style-80156/).
- Edgar Wright dùng khung, độ gần và chuyển động để làm gag: No Film School, [Edgar Wright physical comedy using cinematography](https://nofilmschool.com/2014/05/edgar-wright-physical-comedy-using-cinematography).

## MiniMax Hailuo / H3
- Hướng dẫn bên thứ ba nói H3 hiểu mô tả camera (push in, pull out, tracking, pan, tilt, arc) và khuyên một chuyển động chính mỗi clip: [Kapwing](https://www.kapwing.com/resources/how-to-prompt-minimax-h3-hailuo-3-0-a-guide-for-ai-video-creators/), [fal.ai](https://fal.ai/learn/devs/minimax-hailuo-3-prompting-guide-44-video-examples-fal), [Leadde](https://leadde.ai/blog/mini-max-h3-prompt-guide).
- Lệnh trong ngoặc vuông như `[Push in]`, `[Pan left]` là cú pháp của Hailuo 2.3 và 02, không chắc áp cho H3 (xem [Novita](https://docs.novita.ai/api-reference/model-apis-minimax-hailuo-2.3-t2v.md)). Skill không dùng cú pháp này.

## Chưa xác nhận (kiểm trên H3)
1. H3 có chấp nhận cú cắt góc thật giữa hai shot trong cùng một chain không.
2. Camera chuyển động (push-in, pan, arc) với hai người có làm lệch mặt không. Quy tắc của app tại `src/novelvideo/agents/prompts/minimax_h3_rules.md` cấm chuyển động khi có hai nhân vật trở lên vì sợ mất danh tính; skill này bỏ ràng buộc đó cho long-form và thay bằng chạy thử.
3. Góc một người, góc thấp, góc cao có ra đúng không; giọng người nói ngoài khung có bị gán nhầm người trong khung không.
4. Sheet nhân vật chỉ có hai góc (trước, nghiêng), không có góc lưng, nên qua vai chưa dùng được.
