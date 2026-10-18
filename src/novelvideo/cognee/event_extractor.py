"""Event extractor: extract independent events/scenes from chapters.

Used in AI planning mode; it can split chapters into finer-grained events,
enabling flexible 10-chapter -> 20-episode mappings.
"""

from typing import List, Optional

from pydantic import BaseModel, Field
from rich.console import Console

from .pipeline import NovelEvent

console = Console()


class ExtractedEvent(BaseModel):
    description: str = Field(description="Event description (within 20 words)")
    location: str = Field(default="", description="Location")
    time_marker: str = Field(default="", description="Time marker")
    characters: list[str] = Field(default_factory=list, description="Participating characters")
    start_text: str = Field(default="", description="First 20 words of where the event starts")
    end_text: str = Field(default="", description="Last 20 words of where the event ends")
    causes: list[str] = Field(default_factory=list, description="description of the preceding events")


class ExtractedEventList(BaseModel):
    events: list[ExtractedEvent] = Field(default_factory=list)


class EventExtractor:
    """Extract events from a chapter.

    Each event is a complete narrative unit:
    - one conversation
    - one scene
    - one action sequence

    Splitting principles:
    1. A change of location or time usually means a new event
    2. Keep cause and effect coherent
    3. Label the Freytag narrative-structure role
    """

    def __init__(self):
        pass

    async def extract_events(
        self,
        chapter_num: int,
        chapter_content: str,
        on_log: Optional[callable] = None,
    ) -> List[NovelEvent]:
        """Extract the events in a chapter.

        Args:
            chapter_num: Chapter number
            chapter_content: Chapter content
            on_log: Log callback

        Returns:
            List of events
        """
        from pydantic_ai import Agent
        from novelvideo.config import (
            get_newapi_structured_output_model_settings,
            get_pydantic_model,
        )

        def log(msg: str):
            if on_log:
                on_log(msg)
            console.print(f"[dim]{msg}[/dim]")

        log(f"Extracting events of chapter {chapter_num}...")

        # Truncate the chapter content if it is too long
        truncated = (
            chapter_content[:12000] if len(chapter_content) > 12000 else chapter_content
        )
        if len(chapter_content) > 12000:
            log(f"Chapter content too long ({len(chapter_content)} chars); truncated to the first 12000 chars")

        prompt = f"""Analyze the chapter content below and identify the independent events/scenes in it.

Chapter content:
{truncated}

Event splitting principles:
1. Each event is a complete narrative unit (one conversation, one scene, one action sequence)
2. A change of location or time usually means a new event
3. Keep cause and effect coherent
4. Label the Freytag narrative-structure role:
   - exposition: opening/background introduction
   - rising_action: rising plot/conflict development
   - climax: climax
   - falling_action: falling plot/consequences unfolding
   - resolution: ending/wrap-up
   - narrative: ordinary narration (default)
5. Each chapter usually has 3-8 events"""

        try:
            agent = Agent(
                get_pydantic_model(),
                model_settings=get_newapi_structured_output_model_settings(),
                output_type=ExtractedEventList,
            )
            ai_result = await agent.run(prompt)

            events_data = ai_result.output.events
            log(f"LLM returned {len(events_data)} events")

        except Exception as e:
            log(f"Event extraction failed: {e}")
            # Fallback: treat the whole chapter as one event
            return [
                NovelEvent(
                    event_id=f"ch{chapter_num}_e1",
                    chapter_num=chapter_num,
                    description=f"Chapter {chapter_num} content",
                    content=chapter_content,
                    text_start=0,
                    text_end=len(chapter_content),
                )
            ]

        # Parse events and locate their position in the source text
        events = []
        for i, e in enumerate(events_data):
            # Locate the event boundaries in the source text
            start_text = e.start_text
            end_text = e.end_text

            start_pos = chapter_content.find(start_text) if start_text else -1
            end_pos = chapter_content.find(end_text) if end_text else -1

            if end_pos > 0:
                end_pos += len(end_text)

            # If locating fails, use default values
            if start_pos < 0:
                start_pos = 0
            if end_pos <= start_pos:
                end_pos = len(chapter_content)

            # Extract the event source text
            event_content = chapter_content[start_pos:end_pos]

            event = NovelEvent(
                event_id=f"ch{chapter_num}_e{i + 1}",
                chapter_num=chapter_num,
                description=e.description,
                location=e.location,
                time_marker=e.time_marker,
                characters=e.characters,
                text_start=start_pos,
                text_end=end_pos,
                content=event_content,
                causes=e.causes,
            )
            events.append(event)

        log(f"Chapter {chapter_num} extraction complete: {len(events)} events")
        return events

    async def extract_all_chapters(
        self,
        chapters: List[dict],  # [{"number": 1, "content": "..."}]
        on_progress: Optional[callable] = None,
        on_log: Optional[callable] = None,
    ) -> List[NovelEvent]:
        """Extract the events of all chapters in batch.

        Args:
            chapters: Chapter list; each item contains number and content
            on_progress: Progress callback (progress: float, task: str)
            on_log: Log callback

        Returns:
            List of all events
        """
        all_events = []
        total = len(chapters)

        for i, chapter in enumerate(chapters):
            if on_progress:
                progress = i / total
                on_progress(progress, f"Extracting events of chapter {chapter['number']}...")

            events = await self.extract_events(
                chapter_num=chapter["number"],
                chapter_content=chapter["content"],
                on_log=on_log,
            )
            all_events.extend(events)

        if on_progress:
            on_progress(1.0, f"Event extraction complete, {len(all_events)} events in total")

        return all_events
