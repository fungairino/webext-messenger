import { serializeError } from "serialize-error";

import { getContentScriptMethod } from "./sender.js";
import { Message, MessengerMeta, Method } from "./types.js";
import {
  handlers,
  isObject,
  MessengerError,
  __webext_messenger__,
} from "./shared.js";

export function isMessengerMessage(message: unknown): message is Message {
  return (
    isObject(message) &&
    typeof message["type"] === "string" &&
    message["__webext_messenger__"] === true &&
    Array.isArray(message["args"])
  );
}

// MUST NOT be `async` or Promise-returning-only
function onMessageListener(
  message: unknown,
  sender: browser.runtime.MessageSender
): Promise<unknown> | void {
  if (!isMessengerMessage(message)) {
    // TODO: Add test for this eventuality: ignore unrelated messages
    return;
  }

  const { type, target, args } = message;

  console.debug(`Messenger:`, type, "↘️ received", { sender, args });

  let handleMessage: () => Promise<unknown>;
  if (target) {
    if (!browser.tabs) {
      throw new MessengerError(
        `Message ${type} sent to wrong context, it can't be forwarded to ${JSON.stringify(
          target
        )}`
      );
    }

    console.debug(`Messenger:`, type, "🔀 forwarded", { sender, target });
    const publicMethod = getContentScriptMethod(type);
    handleMessage = async () => publicMethod(target, ...args);
  } else {
    const localHandler = handlers.get(type);
    if (!localHandler) {
      console.warn(`Messenger:`, type, "⚠️ ignored, can't be handled here");
      return;
    }

    console.debug(`Messenger:`, type, "➡️ will be handled here");

    const meta: MessengerMeta = { trace: [sender] };
    handleMessage = async () => localHandler.apply(meta, args);
  }

  return handleMessage()
    .then(
      (value) => ({ value }),
      (error: unknown) => ({
        // Errors must be serialized because the stacktraces are currently lost on Chrome
        // and https://github.com/mozilla/webextension-polyfill/issues/210
        error: serializeError(error),
      })
    )
    .then((response) => {
      console.debug(`Messenger:`, type, "↗️ responding", response);
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Private key
      return { ...response, __webext_messenger__ };
    });
}

export function registerMethods(methods: Partial<MessengerMethods>): void {
  for (const [type, method] of Object.entries(methods)) {
    if (handlers.has(type)) {
      throw new MessengerError(`Handler already set for ${type}`);
    }

    console.debug(`Messenger: Registered`, type);
    handlers.set(type, method as Method);
  }

  if ("browser" in globalThis) {
    browser.runtime.onMessage.addListener(onMessageListener);
  } else {
    throw new Error("`webext-messenger` requires `webextension");
  }
}
