// SPDX-License-Identifier: LGPL-3.0-or-later
// Adapted from Zodiac Roles SDK 3.4.8 (Gnosis Guild contributors).
// Source, modifications and license: see NOTICE.md in this directory.
import { Annotation } from "zodiac-roles-sdk"

import { groupBy } from "../group-by"

import { Diff } from "./helpers"

export function diffAnnotations({
  roleKey,
  prev = [],
  next = [],
}: {
  roleKey: `0x${string}`
  prev?: Annotation[]
  next?: Annotation[]
}): Diff {
  const removeAnnotations = prev
    .map((annotation) => annotation.uri)
    .filter((uri) => !next.some((nextAnnotation) => nextAnnotation.uri === uri))

  const addAnnotations = groupAnnotations(
    next.filter(
      (annotation) =>
        !prev.some(
          (currentAnnotation) =>
            currentAnnotation.uri === annotation.uri &&
            currentAnnotation.schema === annotation.schema
        )
    )
  )

  return {
    minus:
      removeAnnotations.length > 0
        ? [
            {
              call: "postAnnotations",
              roleKey,
              body: { removeAnnotations },
            },
          ]
        : [],
    plus:
      addAnnotations.length > 0
        ? [
            {
              call: "postAnnotations",
              roleKey,
              body: { addAnnotations },
            },
          ]
        : [],
  }
}

const groupAnnotations = (annotations: readonly Annotation[]) =>
  Object.entries(groupBy(annotations, (annotation) => annotation.schema)).map(
    ([schema, annotations]) => ({
      schema,
      uris: annotations.map((annotation) => annotation.uri),
    })
  )
