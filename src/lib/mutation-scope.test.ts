import { expect, it } from "vitest";
import { MutationScope } from "./mutation-scope";

it("aborts a pending order request and rejects its late response after account switch", async () => {
  const scope = new MutationScope(),
    request = scope.begin();
  let finish!: (value: string) => void;
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  scope.cancelAll();
  finish("server-A-order");
  const result = await response;
  expect(result).toBe("server-A-order");
  expect(request.controller.signal.aborted).toBe(true);
  expect(scope.isCurrent(request)).toBe(false);
  expect(scope.isCurrent(scope.begin())).toBe(true);
});

it("rejects a completed request if identity changed before its success callback", () => {
  const scope = new MutationScope(),
    old = scope.begin();
  scope.finish(old);
  scope.cancelAll();
  expect(old.controller.signal.aborted).toBe(false);
  expect(scope.isCurrent(old)).toBe(false);
});
