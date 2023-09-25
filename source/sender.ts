import pRetry from "p-retry";
import { isBackground } from "webext-detect-page";
import { doesTabExist } from "webext-tools";
import { deserializeError } from "serialize-error";

import {
  type MessengerMessage,
  type MessengerResponse,
  type PublicMethod,
  type PublicMethodWithTarget,
  type Options,
  type Target,
  type PageTarget,
  type AnyTarget,
} from "./types.js";
import {
  isObject,
  MessengerError,
  __webextMessenger,
  debug,
  warn,
} from "./shared.js";
import { type SetReturnType } from "type-fest";
import { handlers } from "./handlers.js";

const _errorNonExistingTarget =
  "Could not establish connection. Receiving end does not exist.";

// https://github.com/mozilla/webextension-polyfill/issues/384
const _errorTargetClosedEarly =
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received";

export const errorTargetClosedEarly =
  "The target was closed before receiving a response";
export const errorTabDoesntExist = "The tab doesn't exist";

function isMessengerResponse(response: unknown): response is MessengerResponse {
  return isObject(response) && response["__webextMessenger"] === true;
}

function attemptLog(attemptCount: number): string {
  return attemptCount > 1 ? `(try: ${attemptCount})` : "";
}

function makeMessage(
  type: keyof MessengerMethods,
  args: unknown[],
  target: Target | PageTarget,
  options: Options
): MessengerMessage {
  return {
    __webextMessenger,
    type,
    args,
    target,
    options,
  };
}

// Do not turn this into an `async` function; Notifications must turn `void`
function manageConnection(
  type: string,
  options: Options,
  target: AnyTarget,
  sendMessage: (attempt: number) => Promise<unknown>
): Promise<unknown> | void {
  if (!options.isNotification) {
    return manageMessage(type, target, sendMessage);
  }

  void sendMessage(1).catch((error: unknown) => {
    debug(type, "notification failed", { error });
  });
}

async function manageMessage(
  type: string,
  target: AnyTarget,
  sendMessage: (attempt: number) => Promise<unknown>
): Promise<unknown> {
  const response = await pRetry(
    async (attemptCount) => {
      const response = await sendMessage(attemptCount);

      if (isMessengerResponse(response)) {
        return response;
      }

      // If no one answers, `response` will be `undefined`
      // If the target does not have any `onMessage` listener at all, it will throw
      // Possible:
      // - Any target exists and has onMessage handler, but never handled the message
      // - Extension page exists and has Messenger, but never handled the message (Messenger in Runtime ignores messages when the target isn't found)
      // Not possible:
      // - Tab exists and has Messenger, but never handled the message (Messenger in CS always handles messages)
      // - Any target exists, but Messenger didn't have the specific Type handler (The receiving Messenger will throw an error)
      // - No targets exist (the browser immediately throws "Could not establish connection. Receiving end does not exist.")
      if (response === undefined) {
        if ("page" in target) {
          throw new MessengerError(
            `The target ${JSON.stringify(target)} for ${type} was not found`
          );
        }

        throw new MessengerError(
          `Messenger was not available in the target ${JSON.stringify(
            target
          )} for ${type}`
        );
      }

      // Possible:
      // - Non-Messenger handler responded
      throw new MessengerError(
        `Conflict: The message ${type} was handled by a third-party listener`
      );
    },
    {
      minTimeout: 100,
      factor: 1.3,
      maxRetryTime: 4000,
      async onFailedAttempt(error) {
        if (error.message === _errorTargetClosedEarly) {
          throw new Error(errorTargetClosedEarly);
        }

        if (
          // Don't retry sending to the background page unless it really hasn't loaded yet
          (target.page !== "background" && error instanceof MessengerError) ||
          // Page or its content script not yet loaded
          error.message === _errorNonExistingTarget ||
          // `registerMethods` not yet loaded
          String(error.message).startsWith("No handlers registered in ")
        ) {
          if (
            browser.tabs &&
            typeof target.tabId === "number" &&
            !(await doesTabExist(target.tabId))
          ) {
            throw new Error(errorTabDoesntExist);
          }

          // Fall through, will retry
        } else {
          throw error;
        }
      },
    }
  ).catch((error: Error) => {
    if (error?.message === _errorNonExistingTarget) {
      throw new MessengerError(
        `The target ${JSON.stringify(target)} for ${type} was not found`
      );
    }

    throw error;
  });

  if ("error" in response) {
    debug(type, "↘️ replied with error", response.error);
    throw deserializeError(response.error);
  }

  debug(type, "↘️ replied successfully", response.value);
  return response.value;
}

function messenger<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type]
>(
  type: Type,
  options: { isNotification: true },
  target: Target | PageTarget,
  ...args: Parameters<Method>
): void;
function messenger<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  ReturnValue extends Promise<ReturnType<Method>>
>(
  type: Type,
  options: Options,
  target: Target | PageTarget,
  ...args: Parameters<Method>
): ReturnValue;
function messenger<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  ReturnValue extends Promise<ReturnType<Method>>
>(
  type: Type,
  options: Options,
  target: Target | PageTarget,
  ...args: Parameters<Method>
): ReturnValue | void {
  // Message goes to extension page
  if ("page" in target) {
    if (target.page === "background" && isBackground()) {
      const handler = handlers.get(type);
      if (handler) {
        warn(type, "is being handled locally");
        return handler.apply({ trace: [] }, args) as ReturnValue;
      }

      throw new MessengerError("No handler registered locally for " + type);
    }

    const sendMessage = async (attemptCount: number) => {
      debug(type, "↗️ sending message to runtime", attemptLog(attemptCount));
      return browser.runtime.sendMessage(
        makeMessage(type, args, target, options)
      );
    };

    return manageConnection(type, options, target, sendMessage) as ReturnValue;
  }

  // Contexts without direct Tab access must go through background
  if (!browser.tabs) {
    return manageConnection(
      type,
      options,
      target,
      async (attemptCount: number) => {
        debug(type, "↗️ sending message to runtime", attemptLog(attemptCount));
        return browser.runtime.sendMessage(
          makeMessage(type, args, target, options)
        );
      }
    ) as ReturnValue;
  }

  // `frameId` must be specified. If missing, the message is sent to every frame
  const { tabId, frameId = 0 } = target;

  // Message tab directly
  return manageConnection(
    type,
    options,
    target,
    async (attemptCount: number) => {
      debug(
        type,
        "↗️ sending message to tab",
        tabId,
        "frame",
        frameId,
        attemptLog(attemptCount)
      );
      return browser.tabs.sendMessage(
        tabId,
        makeMessage(type, args, target, options),
        {
          frameId,
        }
      );
    }
  ) as ReturnValue;
}

function getMethod<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodType extends PublicMethod<Method>
>(type: Type, target: Target | PageTarget): PublicMethodType;
function getMethod<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodWithDynamicTarget extends PublicMethodWithTarget<Method>
>(type: Type): PublicMethodWithDynamicTarget;
function getMethod<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodType extends PublicMethod<Method>,
  PublicMethodWithDynamicTarget extends PublicMethodWithTarget<Method>
>(
  type: Type,
  target?: Target | PageTarget
): PublicMethodType | PublicMethodWithDynamicTarget {
  if (arguments.length === 1) {
    return messenger.bind(undefined, type, {}) as PublicMethodWithDynamicTarget;
  }

  // @ts-expect-error `bind` types are junk
  return messenger.bind(undefined, type, {}, target) as PublicMethodType;
}

function getNotifier<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodType extends SetReturnType<PublicMethod<Method>, void>
>(type: Type, target: Target | PageTarget): PublicMethodType;
function getNotifier<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodWithDynamicTarget extends SetReturnType<
    PublicMethodWithTarget<Method>,
    void
  >
>(type: Type): PublicMethodWithDynamicTarget;
function getNotifier<
  Type extends keyof MessengerMethods,
  Method extends MessengerMethods[Type],
  PublicMethodType extends SetReturnType<PublicMethod<Method>, void>,
  PublicMethodWithDynamicTarget extends SetReturnType<
    PublicMethodWithTarget<Method>,
    void
  >
>(
  type: Type,
  target?: Target | PageTarget
): PublicMethodType | PublicMethodWithDynamicTarget {
  const options = { isNotification: true };
  if (arguments.length === 1) {
    // @ts-expect-error `bind` types are junk
    return messenger.bind(
      undefined,
      type,
      options
    ) as PublicMethodWithDynamicTarget;
  }

  // @ts-expect-error `bind` types are junk
  return messenger.bind(undefined, type, options, target) as PublicMethodType;
}

export { messenger, getMethod, getNotifier };
export const backgroundTarget: PageTarget = { page: "background" };
