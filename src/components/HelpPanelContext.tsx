import { createContext, useContext } from "react";

type HelpPanelContextValue = {
  openHelpPanel: (content: React.ReactNode) => void;
  closeHelpPanel: () => void;
};

export const HelpPanelContext = createContext<HelpPanelContextValue>({
  openHelpPanel: () => {},
  closeHelpPanel: () => {},
});

export function useHelpPanel() {
  return useContext(HelpPanelContext);
}
