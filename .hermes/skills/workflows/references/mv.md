# MV Workflow

For MVs, music videos, lyric visualization and rhythm shots.

## Material requirements

- One of the following is required: audio, a song, lyrics, a music style description, a rhythm reference, or an MV brief given by the user in chat.
- Recommended: lyric text, song structure, BPM/rhythm feel, visual style, reference MVs, main visual characters/scenes, final duration.
- Optional: subtitle style, singer/character settings, stage design/scene reference images, shot rhythm, target aspect ratio, platform.

With only lyrics and no audio, you can first plan visuals and shots by lyric paragraphs; with only audio and no lyrics, you can first plan by music sections and mood.

## Production chain

`audio/lyrics input -> section analysis -> rhythm points -> visual style -> shot sections -> visual assets -> video clips -> lyrics/subtitles -> final composition -> rhythm QA`

## Dynamic expansion

- When there is audio, start from `audio_input`.
- When there are lyrics, start from `lyrics_input`.
- Split production units by intro / verse / chorus / bridge / outro or the time ranges given by the user.
- The chorus and high-energy sections can have shots and visual assets split out separately.
- Do not apply product selling points or ad CTAs unless the user explicitly asks for a commercial MV.
