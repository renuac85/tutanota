/* generated file, don't edit. */

import { NativeContact } from "./NativeContact.js"
import { StructuredContact } from "./StructuredContact.js"
/**
 * Common operations implemented by each mobile platform.
 */
export interface MobileSystemFacade {
	/**
	 * Find suggestions in the OS contact provider.
	 */
	findSuggestions(query: string): Promise<ReadonlyArray<NativeContact>>

	/**
	 * Store one or more contacts in system's contact book
	 */
	saveContacts(username: string, contacts: ReadonlyArray<StructuredContact>): Promise<void>

	/**
	 * Sync all Tuta contacts with system's contact book, this operation includes Inserts, Updates and Deletions
	 */
	syncContacts(username: string, contacts: ReadonlyArray<StructuredContact>): Promise<void>

	/**
	 * Delete all or a specific Tuta contact from system's contact book
	 */
	deleteContacts(username: string, contactId: string | null): Promise<void>

	/**
	 * Redirect the user to Phone's Settings
	 */
	goToSettings(): Promise<void>

	/**
	 * Open URI in the OS.
	 */
	openLink(uri: string): Promise<boolean>

	/**
	 * Share the text via OS sharing mechanism.
	 */
	shareText(text: string, title: string): Promise<boolean>
}
