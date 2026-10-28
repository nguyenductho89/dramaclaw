---
version: 2.1.0
attention: medium
---
# v2.1.0

## User-facing Highlights (vi)

- **Trợ lý và quy trình sáng tạo**: Hoàn thiện phương án sáng tạo theo kỹ năng, xác nhận tham số model, thực thi trên canvas và khôi phục tác vụ; hỗ trợ cấu hình model Agent của bên thứ ba.
- **Thêm công cụ canvas**: Bổ sung phân tích video theo từng khung hình, viết tiếp thông minh, cắt khung hình, lối vào bắt chuyển động theo độ sâu và chỉnh kích thước điểm ảnh của ảnh cục bộ; chế độ video khả dụng phụ thuộc vào khả năng của model.
- **Kiểm tra lưu trữ media từ sớm**: CE kiểm tra lưu trữ tự cấu hình trước khi tạo media trả phí và báo sớm các cấu hình không dùng được, tránh lãng phí lượt tạo do lỗi lưu trữ.
- **Văn bản thành video không cần duyệt tư liệu người thật**: Tự động tắt và ẩn công tắc duyệt tư liệu người thật, tránh cấu hình cũ hoặc thao tác nhầm gửi yêu cầu duyệt không cần thiết.
- **Codex 0.164.0**: Bản dựng Docker chính thức nâng lên Codex 0.164.0 có bảo vệ thông tin xác thực, cung cấp image gốc cho AMD64 và ARM64.

## User-facing Highlights (en)

- **Agent-assisted workflows**: Improved skill-driven planning, model parameter confirmation, canvas execution and task recovery, with configurable third-party Agent models.
- **More canvas tools**: Added frame-by-frame video analysis, continuation, cropping, depth motion capture entry points and local image pixel resizing. Available video modes follow model capabilities.
- **Media storage preflight**: CE checks self-configured storage before paid media generation and reports unavailable configurations earlier.
- **No real-person material review for text-to-video**: The review switch is hidden and disabled, preventing stale settings or accidental activation from requesting unnecessary review.
- **Codex 0.164.0**: Official Docker builds use the credential-safe Codex 0.164.0 runtime with native AMD64 and ARM64 images.

## Fixes

- Fixed CE media storage validation and error messages, compatible with Cloudinary re-encoding test images, and improved the Chinese/English UI hints (#868).
- Text-to-video no longer requires real-person material review at the UI, task execution and final request layers; other modes with reference material keep the review capability (#877).
- Improved consistency of workflow planning, model confirmation, execution status and audio delivery (#794, #825, #827, #833, #844, #847).
- Fixed automatic aspect-ratio passing for video processing requests, and bundled the Ladybug JSON extension with the package to avoid a runtime download dependency (#855, #860).

## Improvements

- Added channel model list fetching, searchable model selection and third-party Agent model configuration (#795, #826).
- Added video processing entry points, constrained video modes by model capability, and added local image pixel resizing (#801, #802, #842).
- Added European Portuguese localization and improved the multilingual experience (#866).
- Upgraded the Codex runtime of official Docker builds to 0.164.0, pinning the image digest and verifying commit, architecture, version and binary SHA256.
