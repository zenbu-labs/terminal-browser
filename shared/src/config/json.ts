import { z } from "zod";

// JSON text as a schema input, so file and response shapes can pipe off it.
export const jsonText = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});
