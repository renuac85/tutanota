import m from "mithril"
import {
	assertNotNull,
	base64ToBase64Url,
	base64UrlToBase64,
	decodeBase64,
	filterInt,
	getDayShifted,
	getEndOfDay,
	getStartOfDay,
	incrementMonth,
	isSameTypeRef,
	stringToBase64,
	TypeRef,
} from "@tutao/tutanota-utils"
import { RouteSetFn, throttleRoute } from "../../misc/RouteChange"
import type { SearchRestriction } from "../../api/worker/search/SearchTypes"
import { assertMainOrNode } from "../../api/common/Env"
import { TranslationKey } from "../../misc/LanguageViewModel"
import { CalendarEvent, CalendarEventTypeRef, Contact, ContactTypeRef, Mail, MailTypeRef } from "../../api/entities/tutanota/TypeRefs"
import { typeModels } from "../../api/entities/tutanota/TypeModels.js"
import { locator } from "../../api/main/MainLocator.js"
import { getElementId } from "../../api/common/utils/EntityUtils.js"

assertMainOrNode()

const FIXED_FREE_SEARCH_DAYS = 28

const SEARCH_CATEGORIES = [
	{
		name: "mail",
		typeRef: MailTypeRef,
	},
	{
		name: "contact",
		typeRef: ContactTypeRef,
	},
	{
		name: "calendar",
		typeRef: CalendarEventTypeRef,
	},
] as const

/** get the TypeRef that corresponds to the selected category (as taken from the URL: <host>/search/<category>?<query> */
export function getSearchType(category: string): TypeRef<CalendarEvent> | TypeRef<Mail> | TypeRef<Contact> {
	return assertNotNull(SEARCH_CATEGORIES.find((c) => c.name === category)).typeRef
}

interface SearchMailField {
	readonly textId: TranslationKey
	readonly field: string | null
	readonly attributeIds: number[] | null
}

export const SEARCH_MAIL_FIELDS: ReadonlyArray<SearchMailField> = [
	{
		textId: "all_label",
		field: null,
		attributeIds: null,
	},
	{
		textId: "subject_label",
		field: "subject",
		attributeIds: [typeModels.Mail.values["subject"].id as number],
	},
	{
		textId: "mailBody_label",
		field: "body",
		attributeIds: [typeModels.Mail.associations["body"].id as number],
	},
	{
		textId: "from_label",
		field: "from",
		attributeIds: [typeModels.Mail.associations["sender"].id as number],
	},
	{
		textId: "to_label",
		field: "to",
		attributeIds: [
			typeModels.Mail.associations["toRecipients"].id as number,
			typeModels.Mail.associations["ccRecipients"].id as number,
			typeModels.Mail.associations["bccRecipients"].id as number,
		],
	},
	{
		textId: "attachmentName_label",
		field: "attachment",
		attributeIds: [typeModels.Mail.associations["attachments"].id as number],
	},
]

const routeSetThrottled: RouteSetFn = throttleRoute()

export function setSearchUrl(url: string) {
	if (url !== m.route.get()) {
		routeSetThrottled(url, {})
	}
}

export function searchCategoryForRestriction(restriction: SearchRestriction): string {
	return assertNotNull(SEARCH_CATEGORIES.find((c) => isSameTypeRef(c.typeRef, restriction.type))).name
}

export function getSearchUrl(
	query: string | null,
	restriction: SearchRestriction,
	selectionKey: string | null,
): {
	path: string
	params: Record<string, string | number | Array<string>>
} {
	const category = searchCategoryForRestriction(restriction)
	const params: Record<string, string | number | Array<string>> = {
		query: query ?? "",
		category,
	}
	// a bit annoying but avoids putting unnecessary things into the url (if we woudl put undefined into it)
	if (restriction.start) {
		params.start = restriction.start
	}
	if (restriction.end) {
		params.end = restriction.end
	}
	if (restriction.listIds.length > 0) {
		params.list = restriction.listIds
	}
	if (restriction.field) {
		params.field = restriction.field
	}
	if (restriction.eventSeries != null) {
		params.eventSeries = String(restriction.eventSeries)
	}

	return {
		path: "/search/:category" + (selectionKey ? "/" + selectionKey : ""),
		params: params,
	}
}

export function getFreeSearchStartDate(): Date {
	return getStartOfDay(getDayShifted(new Date(), -FIXED_FREE_SEARCH_DAYS))
}

/**
 * Adjusts the restriction according to the account type if necessary
 */
export function createRestriction(
	searchCategory: string,
	start: number | null,
	end: number | null,
	field: string | null,
	listIds: Array<string>,
	eventSeries: boolean | null,
): SearchRestriction {
	if (locator.logins.getUserController().isFreeAccount() && searchCategory === "mail") {
		start = null
		end = getFreeSearchStartDate().getTime()
		field = null
		listIds = []
		eventSeries = null
	}

	let r: SearchRestriction = {
		type: getSearchType(searchCategory),
		start: start,
		end: end,
		field: null,
		attributeIds: null,
		listIds,
		eventSeries,
	}

	if (!field) {
		return r
	}

	if (searchCategory === "mail") {
		let fieldData = SEARCH_MAIL_FIELDS.find((f) => f.field === field)

		if (fieldData) {
			r.field = field
			r.attributeIds = fieldData.attributeIds
		}
	} else if (searchCategory === "calendar") {
		// nothing to do, the calendar restriction was completely set up already.
	} else if (searchCategory === "contact") {
		if (field === "recipient") {
			r.field = field
			r.attributeIds = [
				typeModels.Contact.values["firstName"].id,
				typeModels.Contact.values["lastName"].id,
				typeModels.Contact.associations["mailAddresses"].id,
			]
		} else if (field === "mailAddress") {
			r.field = field
			r.attributeIds = [typeModels.Contact.associations["mailAddresses"].id]
		}
	}

	return r
}

/**
 * Adjusts the restriction according to the account type if necessary
 */
export function getRestriction(route: string): SearchRestriction {
	let category: string
	let start: number | null = null
	let end: number | null = null
	let field: string | null = null
	let listIds: Array<string> = []
	let eventSeries: boolean | null = null

	if (route.startsWith("/mail") || route.startsWith("/search/mail")) {
		category = "mail"

		if (route.startsWith("/search/mail")) {
			try {
				// mithril will parse boolean but not numbers
				const { params } = m.parsePathname(route)
				if (typeof params["start"] === "string") {
					start = filterInt(params["start"])
				}

				if (typeof params["end"] === "string") {
					end = filterInt(params["end"])
				}

				if (typeof params["field"] === "string") {
					const fieldString = params["field"]
					field = SEARCH_MAIL_FIELDS.find((f) => f.field === fieldString)?.field ?? null
				}

				if (Array.isArray(params["list"])) {
					listIds = params["list"]
				}
			} catch (e) {
				console.log("invalid query: " + route, e)
			}
		}
	} else if (route.startsWith("/contact") || route.startsWith("/search/contact")) {
		category = "contact"
	} else if (route.startsWith("/calendar") || route.startsWith("/search/calendar")) {
		const { params } = m.parsePathname(route)

		try {
			if (typeof params["eventSeries"] === "boolean") {
				eventSeries = params["eventSeries"]
			}

			if (typeof params["start"] === "string") {
				start = filterInt(params["start"])
			}

			if (typeof params["end"] === "string") {
				end = filterInt(params["end"])
			}

			const list = params["list"]
			if (Array.isArray(list)) {
				listIds = list
			}
		} catch (e) {
			console.log("invalid query: " + route, e)
		}

		category = "calendar"
		if (start == null) {
			const now = new Date()
			now.setDate(1)
			start = getStartOfDay(now).getTime()
		}

		if (end == null) {
			const endDate = incrementMonth(new Date(start), 3)
			endDate.setDate(0)
			end = getEndOfDay(endDate).getTime()
		}
	} else {
		throw new Error("invalid type " + route)
	}

	return createRestriction(category, start, end, field, listIds, eventSeries)
}

export function decodeCalendarSearchKey(searchKey: string): { id: Id; start: number } {
	return JSON.parse(decodeBase64("utf-8", base64UrlToBase64(searchKey))) as { id: Id; start: number }
}

export function encodeCalendarSearchKey(event: CalendarEvent): string {
	const eventStartTime = event.startTime.getTime()
	return base64ToBase64Url(stringToBase64(JSON.stringify({ start: eventStartTime, id: getElementId(event) })))
}
