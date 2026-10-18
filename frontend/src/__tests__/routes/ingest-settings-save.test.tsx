// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";

const SUPPORTED_FORMATS_LABEL =
  "Supports .txt / .md / .docx · File up to 512KB · Text up to 100,000 characters";
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          aiAssistant: {
            formatCheck: {
              title: "Format check",
              viewDetails: "View details",
              recommended: "Recommended format",
              noIssues: "No issues",
              close: "Close",
              lineLabel: "Line {{line}}",
            },
          },
          common: {
            loading: "Loading",
            upload: "Upload",
            error: "Error",
            stop: "Stop",
            reupload: "Reupload",
            delete: "Delete",
            close: "Close",
            retry: "Retry",
            cancel: "Cancel",
          },
          ingest: {
            title: "Import Novel",
            subtitle: "Upload your novel file.",
            dropzoneHint: "Click or drop your novel file here",
            supportedFormats: SUPPORTED_FORMATS_LABEL,
            restoredFilename: "Imported novel",
            reimport: "Re-import",
            reimportSourceMissing: "Original upload missing",
            reuploadConfirm: {
              title: "Confirm re-import",
              description: "Rebuild from the existing upload?",
              confirm: "Confirm re-import",
            },
            previewHeading: "Novel Structure Preview",
            knowledgeGraph: {
              title: "Knowledge Graph",
              stats: "{{nodes}} nodes · {{edges}} relationships",
              connections: "{{count}} connections",
              relationships: "Relationships",
              interactionHint: "Drag to pan",
              truncated: "Showing core relationships",
              zoomIn: "Zoom in",
              zoomOut: "Zoom out",
              resetView: "Reset view",
              expand: "Expand graph",
              loadFailed: "Knowledge graph is unavailable",
              loadFailedHint: "Try again later.",
            },
            inputMode: { upload: "Upload Novel", paste: "Paste Text" },
            sourceHint: {
              uploadActive: "Uploaded file active",
              pasteActive: "Pasted text active",
            },
            pastePlaceholder: "Paste novel text here",
            startIngest: "Start Import",
            processing: "Processing...",
            elapsed: "Elapsed {{time}}",
            status: {
              uploaded: "Uploaded",
              importing: "Importing",
              completed: "Completed",
              stopped: "Stopped",
              failed: "Failed",
            },
            saveSettings: "Save Settings",
            settingsSaved: "Project settings saved",
            settingsSaveFailed: "Failed to save project settings",
            selectPlaceholder: "Select",
            projectType: "Project type",
            projectTypeLocked: "Project type is locked after import",
            projectTypes: {
              narrated: "Narrated",
              drama: "Premium drama",
            },
            novelFormat: {
              button: "Premium drama format guide",
              title: "Premium drama format",
              intro: "Use explicit episode and scene boundaries.",
              standardStatus: "Standard",
              standardStatusHint: "Ready to import.",
              warningStatus: "Repairable",
              warningStatusHint: "Import is allowed.",
              blockingStatus: "Blocked",
              blockingStatusHint: "Add scene headers.",
              specLabel: "Standard format",
              repairableLabel: "Automatically repairable format",
              repairableHint: "The source text is not rewritten.",
              rulesLabel: "Writing rules",
              ruleEpisode: "Start every episode with Episode N.",
              ruleScene: "Give every scene its own header.",
              ruleCharacters: "List the characters.",
              ruleBody: "Keep one visible action per line.",
              ruleDialogue: "Write one speaker per line.",
              ruleLocationChange: "Create a new header when location changes.",
              exampleLabel: "Example excerpt",
            },
            sceneHeaders: {
              missing: "Premium drama scripts require scene headers.",
              missingFix: "Add a scene header to every scene.",
              repairable: "Non-standard scene headers will be normalized.",
              repairableFix: "Scene metadata will be normalized.",
              open: "View scenes for {{chapter}}",
              rowCount_one: "{{count}} scene",
              rowCount_other: "{{count}} scenes",
              count_one: "{{count}} scene",
              count_other: "{{count}} scenes",
              scene: "Scene {{number}}",
              characters: "Characters",
              characterSeparator: ", ",
              unknownLocation: "Scene location not detected",
              empty: "No scene text is available",
              unparsedBody: "Text outside recognized scenes",
            },
            chapterDetails: {
              open: "View the text of {{chapter}}",
              description: "Chapter text preview",
              sceneHeaders: "Scene headers",
              body: "Text",
              empty: "No chapter text is available",
              emptyScene: "No text is available for this scene",
            },
            firstPerson: "First person",
            thirdPerson: "Third person",
            ethnicity: "Default unspecified people",
            visualStyles: {
              chinesePeriodDrama: "Chinese period drama",
              anime: "Anime",
              guomanFantasy: "3D Xianxia Guoman",
              postApocalyptic: "Post-apocalyptic",
              realistic: "Realistic",
            },
            ethnicities: {
              chinese: "Chinese",
              japanese: "Japanese",
              korean: "Korean",
              western: "Western",
              mixed: "Mixed",
            },
          },
        },
      },
    },
  });
});

const mocks = vi.hoisted(() => ({
  projectConfig: {
    spine_template: "drama",
    visual_style: "chinese_period_drama",
    narration_style: "first_person",
    ethnicity: "Chinese",
  },
  updateProject: vi.fn(),
  uploadNovel: vi.fn(),
  startIngest: vi.fn(),
  chaptersData: undefined as
    | {
        ok: true;
        data: {
          total_chars: number;
          count: number;
          preview_only?: boolean;
          source_filename?: string;
          chapters: {
            number: number;
            title?: string | null;
            content?: string;
            word_count?: number;
            char_count?: number;
            scene_blocks?: {
              header: string;
              scene_no?: string;
              location?: string;
              time_of_day?: string;
              interior_exterior?: string;
              characters?: string[];
              content?: string;
              content_start_line?: number;
              content_end_line?: number;
            }[];
            unparsed_content_start_line?: number;
            unparsed_content_end_line?: number;
          }[];
        };
      }
    | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ingestTasks: [] as {
    task_type: string;
    episode: number;
    status: string;
    created_at?: string;
  }[],
  // Simulates React Query's isFetchedAfterMount: defaults to true (fresh data fetched after mount);
  // the stale-cache race case sets it to false, meaning the current data is still the old cache from before mount.
  ingestTasksFetchedAfterMount: true,
  refetchKnowledgeGraph: vi.fn(),
  taskStreamOnError: null as ((error: string) => void) | null,
}));

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  type SelectContextValue = {
    value?: string;
    onValueChange?: (value: string) => void;
  };
  const SelectContext = React.createContext<SelectContextValue>({});

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children: ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: ({
      children,
      placeholder,
    }: {
      children?: ((value: string) => ReactNode) | ReactNode;
      placeholder?: ReactNode;
    }) => {
      const ctx = React.useContext(SelectContext);
      if (typeof children === "function") {
        return <span>{ctx.value ? children(ctx.value) : placeholder}</span>;
      }
      return <span>{children ?? placeholder}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => {
      const ctx = React.useContext(SelectContext);
      return (
        <button
          type="button"
          role="option"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

vi.mock("@/lib/queries/projects", () => ({
  useProject: () => ({
    data: { ok: true, data: mocks.projectConfig },
  }),
  useUpdateProject: () => ({
    mutateAsync: mocks.updateProject,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/ingest", () => ({
  useChapters: () => ({ data: mocks.chaptersData, isFetching: false }),
  useKnowledgeGraph: (_project: string, enabled: boolean) => ({
    data: enabled
      ? {
          ok: true,
          data: {
            nodes: [
              {
                id: "node-1",
                label: "Lin Zhao",
                type: "Entity",
                degree: 1,
                properties: { description: "a boy of the rainy alley" },
              },
              {
                id: "node-2",
                label: "Rainy Alley",
                type: "Entity",
                degree: 1,
                properties: {},
              },
            ],
            edges: [
              {
                id: "edge-1",
                source: "node-1",
                target: "node-2",
                relation: "appears_in",
                properties: {},
              },
            ],
            total_nodes: 2,
            total_edges: 1,
            truncated: false,
          }
        }
      : undefined,
    isLoading: false,
    isError: false,
    refetch: mocks.refetchKnowledgeGraph,
  }),
  useUploadNovel: () => ({ mutateAsync: mocks.uploadNovel, isPending: false }),
  useStartIngest: () => ({
    mutateAsync: mocks.startIngest,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({ data: { ok: true, data: [] } }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useCancelTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTasks: () => ({
    data: { ok: true, data: mocks.ingestTasks },
    isFetchedAfterMount: mocks.ingestTasksFetchedAfterMount,
  }),
}));

vi.mock("@/hooks/use-task-stream", () => ({
  useTaskStream: (options: { onError?: (error: string) => void }) => {
    mocks.taskStreamOnError = options.onError ?? null;
    return {
      status: "idle",
      progress: 0,
      currentTask: "",
      result: null,
      error: null,
      logs: [],
    };
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import { IngestPageContent } from "@/routes/_app/projects.$project/ingest";

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.projectConfig = {
    spine_template: "drama",
    visual_style: "chinese_period_drama",
    narration_style: "first_person",
    ethnicity: "Chinese",
  };
  mocks.updateProject.mockReset();
  mocks.updateProject.mockResolvedValue({ ok: true, data: mocks.projectConfig });
  mocks.uploadNovel.mockReset();
  mocks.startIngest.mockReset();
  mocks.chaptersData = undefined;
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.ingestTasks = [];
  mocks.ingestTasksFetchedAfterMount = true;
  mocks.taskStreamOnError = null;
});

describe("IngestPage settings save", () => {
  it("advertises text, markdown and docx uploads", () => {
    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(
      screen.getByText(SUPPORTED_FORMATS_LABEL),
    ).toBeInTheDocument();
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).toHaveAttribute("accept", ".txt,.md,.docx");
  });

  it("shows a format guide that matches the canonical scene header parser", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    await user.click(
      screen.getByRole("button", { name: "Premium drama format guide" }),
    );

    expect(screen.getByText("Premium drama format")).toBeInTheDocument();
    // This Wrapper runs with lng: "en": the samples must give English users a Fountain format they can copy,
    // giving them a Chinese production format would be no help. The verbatim-aligned parse assertion is in
    // tests/test_screenplay_scene_parser.py::test_documented_english_format_example_parses_as_standard.
    expect(
      screen.getAllByText(
        (_content, element) =>
          element?.tagName === "PRE" &&
          element.textContent?.includes("INT. SEOUL SUBWAY STATION - NIGHT") === true,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "PRE" &&
          element.textContent?.includes("SCENE 1 - SEOUL SUBWAY STATION") === true,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/GA TÀU ĐIỆN NGẦM/)).not.toBeInTheDocument();
  });

  it("saves project settings without uploading or starting ingest", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const saveButton = screen.getByRole("button", { name: /save settings/i });
    expect(saveButton).toBeDisabled();

    await user.click(screen.getByRole("option", { name: "Narrated" }));
    await user.click(screen.getByRole("option", { name: "Anime" }));
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith({
        spine_template: "narrated",
        visual_style: "anime",
        narration_style: "first_person",
        ethnicity: "Chinese",
      }),
    );
    expect(mocks.uploadNovel).not.toHaveBeenCalled();
    expect(mocks.startIngest).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Project settings saved");
  });

  it("hides first/third person options for premium drama and reveals them for narrated", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Default config is premium drama → no narration perspective options.
    expect(
      screen.queryByRole("option", { name: "First person" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Third person" }),
    ).not.toBeInTheDocument();

    // Switching to narrated reveals the perspective entry.
    await user.click(screen.getByRole("option", { name: "Narrated" }));

    expect(
      screen.getByRole("option", { name: "First person" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Third person" }),
    ).toBeInTheDocument();
  });

  it("does not persist narration_style when saving a premium drama", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Stay on premium drama (default), only change the visual style so save fires.
    await user.click(screen.getByRole("option", { name: "Anime" }));
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled());
    const payload = mocks.updateProject.mock.calls[0][0];
    expect(payload).not.toHaveProperty("narration_style");
    expect(payload).toMatchObject({
      spine_template: "drama",
      visual_style: "anime",
      ethnicity: "Chinese",
    });
  });

  it("allows re-import once chapters are imported but hides delete", async () => {
    // Imported state: chapters exist, no in-session upload -> previewStatus "completed".
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        source_filename: "original-novel.txt",
        chapters: [{ number: 1, title: "Chapter One", char_count: 10 }],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // The imported summary is shown (file card + preview)...
    expect(screen.getByText("Chapter One")).toBeInTheDocument();
    // ...and users may intentionally rebuild it, without exposing destructive delete.
    expect(screen.getByRole("button", { name: "Re-import" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("re-imports the existing source without uploading it again", async () => {
    const user = userEvent.setup();
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        source_filename: "original-novel.txt",
        chapters: [{ number: 1, title: "Chapter One", char_count: 10 }],
      },
    };
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-reimport" },
    });

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Re-import" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm re-import" }),
    );

    await waitFor(() =>
      expect(mocks.startIngest).toHaveBeenCalledWith({
        filename: "original-novel.txt",
        rebuild: true,
        spine_template: "drama",
      }),
    );
    expect(mocks.uploadNovel).not.toHaveBeenCalled();
  });

  it("retries the same locked source after re-import fails", async () => {
    const user = userEvent.setup();
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        source_filename: "original-novel.txt",
        chapters: [{ number: 1, title: "Chapter One", char_count: 10 }],
      },
    };
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-reimport" },
    });

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "Re-import" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm re-import" }),
    );
    await waitFor(() => expect(mocks.taskStreamOnError).not.toBeNull());

    await act(async () => {
      await mocks.taskStreamOnError?.("Embedding provider returned 429");
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reupload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.startIngest).toHaveBeenCalledTimes(2));
    expect(mocks.startIngest).toHaveBeenLastCalledWith({
      filename: "original-novel.txt",
      rebuild: true,
      spine_template: "drama",
    });
    expect(mocks.uploadNovel).not.toHaveBeenCalled();
  });

  it("shows the knowledge graph result after content is imported", () => {
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        chapters: [{ number: 1, title: "Chapter One", char_count: 10 }],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(
      screen.getByRole("heading", { name: "Knowledge Graph" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 nodes · 1 relationships")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lin Zhao, Entity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rainy Alley, Entity" })).toBeInTheDocument();
  });

  it("does not request or show the graph for an upload-only chapter preview", () => {
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        preview_only: true,
        chapters: [{ number: 1, title: "Chapter One", char_count: 10 }],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(
      screen.queryByRole("heading", { name: "Knowledge Graph" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to chapter content title and legacy char count in preview", () => {
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 24,
        count: 2,
        chapters: [
          {
            number: 1,
            title: null,
            content: "Chapter One The Journey\nThe King of Qin enters the palace.",
            word_count: 12,
          },
          {
            number: 2,
            title: "Chapter Two Wind Rises",
            char_count: 12,
          },
        ],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(screen.getByText("Chapter One The Journey")).toBeInTheDocument();
    expect(screen.getByText("Chapter Two Wind Rises")).toBeInTheDocument();
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the current upload preview when the replacement picker is cancelled", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockImplementation(async () => {
      mocks.chaptersData = {
        ok: true,
        data: {
          total_chars: 12,
          count: 1,
          preview_only: true,
          source_filename: "novel.txt",
          chapters: [
            {
              number: 1,
              title: "Chapter One First Meeting",
              char_count: 12,
              scene_blocks: [],
            },
          ],
        },
      };
      return {
        ok: true,
        data: {
          filename: "novel.txt",
          size: 12,
          total_chars: 12,
          count: 1,
          chapters: mocks.chaptersData.data.chapters,
        },
      };
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const initialInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    await user.upload(
      initialInput!,
      new File(["Chapter One First Meeting"], "novel.txt", { type: "text/plain" }),
    );

    expect(screen.getByText("Chapter One First Meeting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reupload" }));

    // Cancelling the native picker emits no change event. The existing file
    // and parsed chapter preview must therefore remain untouched.
    expect(screen.getAllByText("novel.txt")).toHaveLength(2);
    expect(screen.getByText("Chapter One First Meeting")).toBeInTheDocument();
    expect(mocks.uploadNovel).toHaveBeenCalledTimes(1);
  });

  it("replaces the preview after a replacement upload succeeds", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockImplementation(
      async ({ file }: { file: File; spineTemplate: string }) => {
        const title =
          file.name === "replacement.txt" ? "Chapter One New Content" : "Chapter One Old Content";
        const chapters = [{
          number: 1,
          title,
          content: `${title}\nBody text.`,
          char_count: 8,
          scene_blocks: [],
        }];
        mocks.chaptersData = {
          ok: true,
          data: {
            total_chars: 8,
            count: 1,
            preview_only: true,
            source_filename: file.name,
            chapters,
          },
        };
        return {
          ok: true,
          data: {
            filename: file.name,
            size: 8,
            total_chars: 8,
            count: 1,
            chapters,
          },
        };
      },
    );

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const initialInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]:not([aria-label="Reupload"])',
    );
    await user.upload(
      initialInput!,
      new File(["Chapter One Old Content"], "novel.txt", { type: "text/plain" }),
    );
    expect(screen.getByText("Chapter One Old Content")).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("Reupload"),
      new File(["Chapter One New Content"], "replacement.txt", { type: "text/plain" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Chapter One New Content")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Chapter One Old Content")).not.toBeInTheDocument();
    expect(mocks.uploadNovel).toHaveBeenLastCalledWith(
      expect.objectContaining({ spineTemplate: "drama" }),
    );
    expect(mocks.uploadNovel).toHaveBeenCalledTimes(2);
  });

  it("opens premium drama scene blocks from a chapter row", async () => {
    const user = userEvent.setup();
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 36,
        count: 1,
        chapters: [
          {
            number: 1,
            title: "Episode One First Meeting",
            char_count: 36,
            content:
              "Episode One First Meeting\r1-1 Rainy Alley NIGHT EXT\rCharacters: Lin Zhao, Su Ran\r△ Lin Zhao stops under the eaves.",
            scene_blocks: [
              {
                header: "1-1 Rainy Alley NIGHT EXT",
                scene_no: "1",
                location: "Rainy Alley",
                time_of_day: "night",
                interior_exterior: "ext",
                characters: ["Lin Zhao", "Su Ran"],
                content_start_line: 3,
                content_end_line: 4,
              },
            ],
          },
        ],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(screen.getByText("1 scene")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "View scenes for Episode One First Meeting",
      }),
    );

    expect(screen.getAllByText("1 scene")).toHaveLength(2);
    expect(screen.getByText("Scene 1")).toBeInTheDocument();
    expect(screen.getAllByText("Rainy Alley").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText((_content, element) =>
        element?.tagName === "P"
          ? element.textContent?.includes("Lin Zhao, Su Ran") ?? false
          : false,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("1-1 Rainy Alley NIGHT EXT")).toBeInTheDocument();
    expect(screen.getByText("△ Lin Zhao stops under the eaves.")).toBeInTheDocument();
    expect(screen.queryByTestId("chapter-body")).not.toBeInTheDocument();
  });

  it("falls back to raw chapter text when premium drama scenes are missing", async () => {
    const user = userEvent.setup();
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 20,
        count: 1,
        chapters: [{
          number: 1,
          title: "Episode One Needs Repair",
          char_count: 20,
          content: "Episode One Needs Repair\nThis passage has no recognizable scene heading.",
          scene_blocks: [],
        }],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    await user.click(
      screen.getByRole("button", {
        name: "View scenes for Episode One Needs Repair",
      }),
    );

    expect(screen.getByTestId("chapter-body")).toHaveTextContent(
      "Episode One Needs Repair This passage has no recognizable scene heading.",
    );
  });

  it("opens chapter text in the same drawer for narrated projects", async () => {
    const user = userEvent.setup();
    mocks.projectConfig = {
      ...mocks.projectConfig,
      spine_template: "narrated",
    };
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 24,
        count: 1,
        chapters: [
          {
            number: 1,
            title: "Chapter One Mountain Rain",
            char_count: 24,
            content: "Chapter One Mountain Rain\nThe rain fell from dusk until late at night.",
          },
        ],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    await user.click(
      screen.getByRole("button", {
        name: "View the text of Chapter One Mountain Rain",
      }),
    );

    expect(screen.getByText("Chapter text preview")).toBeInTheDocument();
    expect(screen.getByTestId("chapter-body")).toHaveTextContent(
      "Chapter One Mountain Rain The rain fell from dusk until late at night.",
    );
    expect(screen.queryByText("Scenes")).not.toBeInTheDocument();
  });

  it("starts ingest with NiceGUI-compatible rebuild enabled", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-1" },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );

    await user.click(screen.getByRole("button", { name: /start import/i }));

    await waitFor(() =>
      expect(mocks.startIngest).toHaveBeenCalledWith({
        filename: "novel.txt",
        rebuild: true,
        spine_template: "drama",
      }),
    );
  });

  it("starts elapsed timing after project settings finish saving", async () => {
    const user = userEvent.setup();
    let nowMs = Date.parse("2026-08-01T00:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.updateProject.mockImplementation(async () => {
      nowMs += 60_000;
      return { ok: true, data: mocks.projectConfig };
    });
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-1" },
    });

    try {
      const { container } = render(
        <Wrapper>
          <IngestPageContent project="demo" />
        </Wrapper>,
      );
      const fileInput = container.querySelector<HTMLInputElement>(
        'input[type="file"]',
      );
      await user.upload(
        fileInput!,
        new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
      );
      await user.click(screen.getByRole("option", { name: "Narrated" }));
      await user.click(screen.getByRole("button", { name: /start import/i }));

      expect(await screen.findByText("Elapsed 00:00")).toBeInTheDocument();
      expect(mocks.updateProject).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("blocks a headerless premium drama before starting ingest", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: {
        filename: "novel.txt",
        size: 12,
        format_check: {
          level: "ok",
          summary: "Uploaded",
          scene_header_status: "missing",
          issues: [],
        },
      },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );

    expect(
      screen.getByText("Premium drama scripts require scene headers."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start import/i })).toBeDisabled();
    expect(mocks.startIngest).not.toHaveBeenCalled();

    await user.click(screen.getByRole("option", { name: "Narrated" }));
    expect(screen.getByRole("button", { name: /start import/i })).toBeEnabled();
  });

  it("does not let a blocking import check disable project settings save", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: {
        filename: "novel.txt",
        size: 12,
        format_check: {
          level: "ok",
          summary: "Uploaded",
          scene_header_status: "missing",
          issues: [],
        },
      },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("option", { name: "Anime" }));

    const saveButton = screen.getByRole("button", { name: /save settings/i });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith({
        spine_template: "drama",
        visual_style: "anime",
        ethnicity: "Chinese",
      }),
    );
    expect(mocks.startIngest).not.toHaveBeenCalled();
  });

  it("allows import when non-standard scene headers can be normalized", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: {
        filename: "script.txt",
        size: 12,
        format_check: {
          level: "ok",
          summary: "Uploaded",
          scene_header_status: "repairable",
          issues: [],
        },
      },
    });
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-1" },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    await user.upload(
      fileInput!,
      new File(["Scene 1"], "script.txt", { type: "text/plain" }),
    );

    expect(
      screen.getByText("Non-standard scene headers will be normalized."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View details" }));
    expect(
      within(screen.getByRole("dialog")).getAllByText(
        "Non-standard scene headers will be normalized.",
      ),
    ).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    const startButton = screen.getByRole("button", { name: /start import/i });
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    await waitFor(() =>
      expect(mocks.startIngest).toHaveBeenCalledWith({
        filename: "script.txt",
        rebuild: true,
        spine_template: "drama",
      }),
    );
  });

  it("shows the backend upload error instead of a generic failure", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockRejectedValue(new Error("Failed to parse chapters: unsupported file encoding"));

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["bad"], "broken.txt", { type: "text/plain" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Failed to parse chapters: unsupported file encoding"),
    );
  });

  it("keeps the ingest failure detail visible on the uploaded file card", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.startIngest.mockRejectedValue(new Error("Knowledge graph build failed: provider error"));

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );

    await user.click(screen.getByRole("button", { name: /start import/i }));

    expect(
      await screen.findByText("Knowledge graph build failed: provider error"),
    ).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith("Knowledge graph build failed: provider error");
  });

  it("allows retrying the same upload after an asynchronous ingest failure", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-1" },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: /start import/i }));

    await waitFor(() => expect(mocks.taskStreamOnError).not.toBeNull());
    act(() => {
      mocks.taskStreamOnError?.("Embedding provider returned 429");
    });

    expect(
      screen.getByRole("button", { name: /start import/i }),
    ).toBeEnabled();
    expect(screen.getByText("Embedding provider returned 429")).toBeInTheDocument();
    expect(mocks.uploadNovel).toHaveBeenCalledTimes(1);
  });

  it("restores the import progress view on mount when an ingest_fast task is still running", async () => {
    // Bug: navigating away mid-import and back reset the local flags, so the
    // page fell back to the empty upload zone even though the server task was
    // still running (chapters not yet durably imported). Mount reconcile must
    // re-open the progress view.
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "running" },
    ];

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Progress view: restored file card with the "Importing" status badge.
    // (Chapters aren't durably imported yet mid-import, so the structure
    // preview section stays empty — the point is we don't fall back to the
    // upload zone.)
    expect(await screen.findByText("Importing")).toBeInTheDocument();
    expect(screen.getByText("Imported novel")).toBeInTheDocument();
    // The empty upload zone must be gone.
    expect(
      screen.queryByText(SUPPORTED_FORMATS_LABEL),
    ).not.toBeInTheDocument();
  });

  it("keeps the persisted start while task-list completion races the SSE", async () => {
    const nowMs = Date.parse("2026-08-01T00:05:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    mocks.ingestTasks = [
      {
        task_type: "ingest_fast",
        episode: 0,
        status: "running",
        created_at: "2026-08-01T00:00:00Z",
      },
    ];

    try {
      const view = render(
        <Wrapper>
          <IngestPageContent project="demo" />
        </Wrapper>,
      );
      expect(await screen.findByText("Elapsed 05:00")).toBeInTheDocument();

      mocks.ingestTasks = [
        {
          task_type: "ingest_fast",
          episode: 0,
          status: "completed",
          created_at: "2026-08-01T00:00:00Z",
        },
      ];
      view.rerender(
        <Wrapper>
          <IngestPageContent project="demo" />
        </Wrapper>,
      );

      expect(screen.getByText("Elapsed 05:00")).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not restore the import view when no ingest task is active", () => {
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "completed" },
    ];

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Completed (not active) → stays on the normal upload zone.
    expect(
      screen.getByText(SUPPORTED_FORMATS_LABEL),
    ).toBeInTheDocument();
    expect(screen.queryByText("Importing")).not.toBeInTheDocument();
  });

  it("waits for tasks fetched after mount before reconciling (ignores stale cache)", async () => {
    // Stale-cache race: the tasks(project) cache is globally shared (no episode, staleTime=0),
    // and on mount React Query first synchronously emits the old cache and then refetches in the background. Reconciling once against the stale data from before mount
    // would lock the state, and when the real data arrives it would exit early -> recovery is permanently missed. The fix uses
    // isFetchedAfterMount to accept only the fresh data fetched after this mount.
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "running" },
    ];
    mocks.ingestTasksFetchedAfterMount = false;

    const { rerender } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Data is still the old cache from before mount -> must not reconcile, stay on the upload area.
    expect(
      screen.getByText(SUPPORTED_FORMATS_LABEL),
    ).toBeInTheDocument();
    expect(screen.queryByText("Importing")).not.toBeInTheDocument();

    // Fresh data after mount has arrived -> only now is reconciling and restoring the progress view allowed.
    mocks.ingestTasksFetchedAfterMount = true;
    rerender(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    expect(await screen.findByText("Importing")).toBeInTheDocument();
  });

  it("re-reconciles when the project changes (per-project reconcile state)", async () => {
    // Reconcile state is tracked per project: when the component is reused across projects, switching to a new project with an active import must
    // reconcile again, and must not be stuck by the previous project's boolean "already reconciled" state.
    mocks.ingestTasks = []; // demo: no active task

    const { rerender } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    expect(
      screen.getByText(SUPPORTED_FORMATS_LABEL),
    ).toBeInTheDocument();

    // Switch to the other project, and it has an active ingest_fast.
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "running" },
    ];
    rerender(
      <Wrapper>
        <IngestPageContent project="other" />
      </Wrapper>,
    );
    expect(await screen.findByText("Importing")).toBeInTheDocument();
  });

  it("clears leaked progress state when switching to a project without active ingest", async () => {
    // Reverse reconcile: when the component is reused across projects, A (active import) -> B (no active ingest_fast) must clear
    // the progress view state left over from A, otherwise B would wrongly show an "Importing" card and make useTaskStream
    // connect to an SSE that does not exist. Under a normal route the parent remounts per project as a fallback; here the
    // project prop is swapped directly to reproduce the "reused" scenario and verify the defensive cleanup of the else branch.
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "running" },
    ];

    const { rerender } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );
    // demo: active import -> progress view restored.
    expect(await screen.findByText("Importing")).toBeInTheDocument();

    // Switch to the other project, which has no active task.
    mocks.ingestTasks = [];
    rerender(
      <Wrapper>
        <IngestPageContent project="other" />
      </Wrapper>,
    );

    // The leftover "Importing" must be cleared and fall back to the upload area.
    expect(
      await screen.findByText(SUPPORTED_FORMATS_LABEL),
    ).toBeInTheDocument();
    expect(screen.queryByText("Importing")).not.toBeInTheDocument();
  });
});
