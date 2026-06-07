export const audioTranscriptPrompt = `
Transcribe the audio faithfully.

- Preserve the spoken wording and meaningful pauses.
- Do not summarize, paraphrase, or correct the speaker's intent.
- Include speaker changes when the transcription model supports speaker diarization.
- Preserve timestamps when the transcription model supports them.
- Use "Speaker unknown" when a speaker cannot be identified.
`.trim();
