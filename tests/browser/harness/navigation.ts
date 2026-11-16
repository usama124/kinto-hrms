// Shell only uses refresh on logout; input tests never navigate or log out.
export function useRouter() {
  return { refresh() {} }
}
