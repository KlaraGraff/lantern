import { lazy, Suspense, useEffect, useState } from "react";

import {
  settingsDestinationSection,
  settingsDestinationView,
  type SettingsDestination,
} from "./settings-destination";
import { listenForOpenSettings } from "./settings-open";

// Every settings section ships in this chunk. It is fetched on the first open
// rather than at startup, and stays mounted after that.
const SettingsModal = lazy(() => import("./SettingsModal"));

/**
 * The settings modal, mounted once for the whole window.
 *
 * It used to live inside `Home`, which held together only because opening a
 * book meant opening a second OS window — the library stayed mounted behind it.
 * Where there is one window (D-005 `hasWindow`), reading a book unmounts `Home`
 * and takes every route into settings with it. Mounting the modal above the
 * router makes "open settings" mean the same thing from either page.
 *
 * A component of its own rather than state in `App`, so that opening the modal
 * re-renders the modal instead of the whole page underneath it.
 */
export default function SettingsHost() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [destination, setDestination] = useState<SettingsDestination>("root");

  useEffect(() => listenForOpenSettings((next) => {
    setDestination(next);
    setOpen(true);
    setOpened(true);
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        // A keyboard shortcut is a desktop gesture and it keeps its desktop
        // landing spot, rather than following the gear button to the root list.
        setDestination("general");
        setOpen(true);
        setOpened(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!opened) return null;

  return (
    <Suspense fallback={null}>
      <SettingsModal
        open={open}
        onClose={() => {
          setOpen(false);
          setDestination("root");
        }}
        initialSection={settingsDestinationSection(destination)}
        initialView={settingsDestinationView(destination)}
      />
    </Suspense>
  );
}
