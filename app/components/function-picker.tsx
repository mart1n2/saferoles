import { useEffect, useId, useMemo, useRef, useState } from "react";

export type PickerFunction = { signature: string; readable: string; selector: string; readOnly: boolean };

/** Search-as-you-type function chooser: matches list under the input, arrow keys and Enter pick. */
export function FunctionPicker({
  functions,
  value,
  onSelect,
}: {
  functions: PickerFunction[];
  value: string;
  onSelect: (entry: PickerFunction) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = functions.find((entry) => entry.signature === value);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = functions.filter((entry) => !needle || entry.readable.toLowerCase().includes(needle));
    // State-changing first: read-only functions grant nothing.
    return [...found.filter((entry) => !entry.readOnly), ...found.filter((entry) => entry.readOnly)];
  }, [functions, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (entry: PickerFunction) => {
    onSelect(entry);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="function-picker" ref={root}>
      <input
        type="text"
        role="combobox"
        aria-label="Function"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={selected ? selected.readable : `Search ${functions.length} functions, e.g. transfer`}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[active]) {
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {selected && !query && <small className="function-picker-current">Selected: <code>{selected.readable}</code></small>}
      {open && (
        <ul className="function-picker-list" role="listbox" id={listId}>
          {matches.length === 0 && <li className="function-picker-empty">No function matches “{query}”.</li>}
          {matches.map((entry, index) => (
            <li
              key={entry.selector}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={entry.signature === value}
              className={`${index === active ? "active" : ""} ${entry.readOnly ? "read-only" : ""}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(entry);
              }}
            >
              <code>{entry.readable}</code>
              {entry.readOnly && <small>read-only · grants nothing</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
