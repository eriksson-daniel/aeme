import { cn } from "cn";

import type { CellPerson } from "../lib/responders.ts";
import { initialOf, textColorOn } from "../lib/user-color.ts";

type Props = {
  people: CellPerson[];
  className?: string;
};

/** A cell split into one stripe per person who can make it, each in that
 * person's color and labelled with their initial where it fits. Whether the
 * letter fits is left to a container query on each stripe rather than a
 * count threshold, so the same component works in cells of any width.
 *
 * Each stripe carries its own tooltip naming just that person, overriding
 * the cell's list of everyone. Pointer events still reach the cell through
 * bubbling, so clicking and drag-selecting across stripes work as before. */
export const PersonSegments = ({ people, className }: Props) =>
  people.length > 0 && (
    <div aria-hidden className={cn("absolute inset-0 flex", className)}>
      {people.map((person) => (
        <div
          key={person.userId}
          title={person.plusOne ? `${person.name} +1` : person.name}
          className="@container flex min-w-0 flex-1 items-center justify-center overflow-hidden not-first:border-l not-first:border-black/25"
          style={{ backgroundColor: person.color, color: textColorOn(person.color) }}
        >
          <span className="hidden text-[9px] leading-none font-semibold @min-[9px]:block">
            {initialOf(person.name)}
          </span>
        </div>
      ))}
    </div>
  );
