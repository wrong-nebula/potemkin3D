import { agentTools, createAgent, registerTools } from '@ui-sdk/web/agent';

type ConfirmFn = (message: string, signal: AbortSignal) => boolean | Promise<boolean>;

let confirmHandler: ConfirmFn | null = null;

export function setAgentConfirmHandler(fn: ConfirmFn | null) {
  confirmHandler = fn;
}

export const agent = createAgent({
  allow: (step, { signal }) => {
    if (!step.confirm) return true;
    return confirmHandler ? confirmHandler(step.confirm, signal) : false;
  },
});

const unregister = registerTools(agent, { allow: () => true });

if (import.meta.hot) {
  import.meta.hot.dispose(unregister);
}

Object.assign(window, { agent, agentTools });
