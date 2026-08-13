async function main(workbook: ExcelScript.Workbook) {
    // ===== fill in the token once =====
    const JIRA_BASE = "https://comviva.atlassian.net";
    const JIRA_EMAIL = "shashidhar.yadala@comviva.com";
    const JIRA_TOKEN = "PASTE_YOUR_API_TOKEN_HERE";  // id.atlassian.com/manage-profile/security/api-tokens
    const SHEET_NAME = "Overall Project Automation";

    const autoGrp = `type = Test AND "internal test type[dropdown]" IN (Automated, Partially-Automated, Automated-Frontend, Automated-Backend)`;
    const notAuto = `type = Test AND "internal test type[dropdown]" = "Not Automatable"`;
    const ussd = `labels IN (USSD, USSD_UAT, USSD_Patch_B1, USSD_Card_Activation, USSD_TEST_CASES)`;

    const map: { cell: string; jql: string }[] = [
        { cell: "F2", jql: `project = BMX AND ${autoGrp} AND labels = API` },
        { cell: "F3", jql: `project = BMX AND ${autoGrp} AND labels = WEB` },
        { cell: "F4", jql: `project = BMX AND ${autoGrp} AND ${ussd}` },
        { cell: "H2", jql: `project = BMX AND ${notAuto} AND labels = API` },
        { cell: "H3", jql: `project = BMX AND ${notAuto} AND labels = WEB` },
        { cell: "H4", jql: `project = BMX AND ${notAuto} AND ${ussd}` },
    ];

    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) {
        throw new Error(`Sheet "${SHEET_NAME}" not found. Check the tab name for typos or trailing spaces.`);
    }

    const auth = "Basic " + base64Encode(`${JIRA_EMAIL}:${JIRA_TOKEN}`);
    let ok = 0;

    for (const item of map) {
        try {
            const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/approximate-count`, {
                method: "POST",
                headers: {
                    "Authorization": auth,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({ jql: item.jql })
            });

            if (resp.status === 200) {
                const data = await resp.json() as { count: number };
                sheet.getRange(item.cell).setValue(data.count);
                ok++;
            } else {
                console.log(`Error ${item.cell}: HTTP ${resp.status} - ${await resp.text()}`);
            }
        } catch (e) {
            // fetch itself threw: almost always CORS, since Office Scripts runs in the
            // browser sandbox and Jira Cloud rejects cross-origin Basic auth.
            console.log(`Request failed for ${item.cell} (likely CORS): ${e}`);
        }
    }

    console.log(`BTC refresh finished: ${ok} of ${map.length} cells updated.`);
}

function base64Encode(input: string): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "", i = 0;
    while (i < input.length) {
        const c1 = input.charCodeAt(i++), c2 = input.charCodeAt(i++), c3 = input.charCodeAt(i++);
        const e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4);
        let e3 = ((c2 & 15) << 2) | (c3 >> 6), e4 = c3 & 63;
        if (isNaN(c2)) { e3 = 64; e4 = 64; } else if (isNaN(c3)) { e4 = 64; }
        output += chars.charAt(e1) + chars.charAt(e2) +
            (e3 === 64 ? "=" : chars.charAt(e3)) + (e4 === 64 ? "=" : chars.charAt(e4));
    }
    return output;
}
