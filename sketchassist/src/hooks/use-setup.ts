import { useState } from "react";

const STORAGE_KEY = "sketchassist-setup-complete";

export function useSetup() {
  const [setupComplete, setSetupComplete] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY) === "1";
  });

  const markComplete = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setSetupComplete(true);
  };

  const resetSetup = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSetupComplete(false);
  };

  return { setupComplete, markComplete, resetSetup };
}
