export type { DocumentId, LocationId, LocationKind, Sha256 } from './ids';
export { createSha256, sha256Hex } from './identity/fingerprint';
export type { Sha256Hasher } from './identity/fingerprint';
export { canonicalLink, cleanLink } from './identity/canonical-link';
export { canonicalFileLocation, canonicalLocation, locationId } from './identity/location';
