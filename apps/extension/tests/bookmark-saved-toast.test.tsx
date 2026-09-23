// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookmarkSavedToast } from "../src/app/components/BookmarkSavedToast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

function renderToast(onSaveNote = vi.fn().mockResolvedValue(undefined)) {
  const onDismiss = vi.fn();
  act(() => {
    root.render(<BookmarkSavedToast message="Nook: Saved to bookmarks ✓" onSaveNote={onSaveNote} onDismiss={onDismiss} />);
  });
  return { onDismiss, onSaveNote };
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No "${label}" button`);
  return match;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("BookmarkSavedToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders a compact pill with the message, Add a note and Close", () => {
    renderToast();
    expect(container.textContent).toContain("Saved to bookmarks ✓");
    expect(container.textContent).not.toContain("Nook:");
    expect(button("Add a note")).toBeTruthy();
    expect(button("Close")).toBeTruthy();
    expect(container.textContent).not.toContain("Dismiss");
  });

  it("closes itself after 5s without interaction", () => {
    const { onDismiss } = renderToast();
    advance(4900);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(200);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes immediately from the close button", () => {
    const { onDismiss } = renderToast();
    act(() => button("Close").click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open while a note is being written, and resumes after Cancel", () => {
    const { onDismiss } = renderToast();
    act(() => button("Add a note").click());
    expect(container.querySelector("textarea")).not.toBeNull();

    advance(30_000);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    advance(5100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("pauses while hovered", () => {
    const { onDismiss } = renderToast();
    const pill = container.firstElementChild!;
    act(() => {
      pill.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    advance(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      pill.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    advance(5100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("saves the note, confirms, then closes shortly after", async () => {
    const { onDismiss, onSaveNote } = renderToast();
    act(() => button("Add a note").click());
    const textarea = container.querySelector("textarea")!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "read later");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => button("Save note").click());

    expect(onSaveNote).toHaveBeenCalledWith("read later");
    expect(container.textContent).toContain("Note saved");
    advance(2100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
