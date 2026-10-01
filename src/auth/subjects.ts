import type { SubjectType } from '../generated/prisma/enums.js';

/** Audit entity type of each subject (spec 01, section 8): the snake_case name of its table row. */
export function entityTypeOf(subjectType: SubjectType): 'user' | 'staff_member' | 'platform_admin' {
  switch (subjectType) {
    case 'owner':
      return 'user';
    case 'staff':
      return 'staff_member';
    case 'platform_admin':
      return 'platform_admin';
  }
}
