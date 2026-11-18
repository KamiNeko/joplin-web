/** Id of the search field in the mobile menu, so Ctrl+K can focus it when it opens the menu */
export const MOBILE_SEARCH_INPUT_ID = "mobile-sidebar-search";

/** Short summary of the search syntax, shown as the search fields' tooltip and with empty results */
export const SEARCH_SYNTAX_HINT =
  'All words must match. Use "exact phrase", -word to exclude, and filters tag:name, notebook:name, type:todo, iscompleted:0.';

/**
 * Classes for sidebar row action buttons: shown on hover/focus on wide screens with a mouse,
 * always visible on small or touch screens, which have no hover.
 */
export const ROW_ACTION_VISIBILITY =
  "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/** localStorage key holding the JSON array of explicitly expanded notebook IDs in the sidebar */
export const EXPANDED_NOTEBOOKS_STORAGE_KEY = "joplin-sidebar-expanded-notebooks";

/** localStorage key holding whether the sidebar Tags section is explicitly expanded ("true"/"false") */
export const TAGS_EXPANDED_STORAGE_KEY = "joplin-sidebar-tags-expanded";
