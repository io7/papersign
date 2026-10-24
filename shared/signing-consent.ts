export const SIGNING_CONSENT = Object.freeze({
  version: "2026-10-22.1",
  text: "I have reviewed this document and my completed fields. I agree to be bound by its terms and to apply my electronic signature. I understand that the later listed signers may add their signatures and signing details.",
});

export interface SigningVerification {
  required: true;
  verified: boolean;
  emailHint: string;
  deliveryAvailable: boolean;
}
