import { addFontDetailed, canUseScope, FontInputError } from './fonts.ts'
import type { FontOverride, FontValueSource } from './fontFile.ts'
import { store } from './store.ts'
import type { CustomFont, FontScope } from '../shared/fonts.ts'

/**
 * An agent adding a font file to the library a canvas designs with
 * (upload_font over MCP, its curl ticket, and the resident's upload_font):
 * the canvas's workspace library, or its owner's own for a personal canvas.
 * The font is then used by family name and Doop writes the @font-face, the
 * way an uploaded library font always is, instead of the file riding inside
 * the frame as base64.
 */

/** The library a canvas's fonts live in, if this person may add to it. */
function scopeFor(canvasId: string, userId: string): FontScope {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new FontInputError('canvas not found')
  if (canvas.workspaceId) {
    const scope = { workspaceId: canvas.workspaceId }
    if (!canUseScope(scope, userId))
      throw new FontInputError("only members of this canvas's workspace can add to its font library")
    return scope
  }
  if (canvas.ownerId !== userId)
    throw new FontInputError(
      "this personal canvas uses its owner's font library, which only they can add to: ask them to upload the font in Settings → Fonts",
    )
  return { personal: true }
}

export async function addCanvasFont(
  canvasId: string,
  user: { id: string; name: string },
  buf: Buffer,
  fileName: string,
  override: FontOverride = {},
): Promise<AddedFont> {
  return addFontDetailed(scopeFor(canvasId, user.id), user, buf, fileName, override)
}

export interface AddedFont {
  font: CustomFont
  weightSource: FontValueSource
  styleSource: FontValueSource
}

/** What an agent is told once its font is in the library, including where the
 *  stored weight and style came from so a wrong read can be caught and redone
 *  with `weight` / `style`. */
export function uploadedFontResult({ font, weightSource, styleSource }: AddedFont) {
  return {
    ok: true,
    family: font.family,
    weight: font.weight,
    weight_from: weightSource,
    style: font.style,
    style_from: styleSource,
    css: `font-family: "${font.family}", sans-serif;`,
    note: `Added to this canvas's font library. Name the family in CSS (${`font-family: "${font.family}"`}) and Doop writes the @font-face into the frame; never inline the file. Upload each weight and style you use as its own file. If the weight or style is wrong for this file, upload it again with weight and style set.`,
  }
}
