import { renderSidebar, renderSidebarFromGlobalState } from './lib/sidebar.js'
import { setupExplore } from './lib/explore.js'
import { setupPageFilter } from './lib/pageFilter.js'
import syncFixtures from './lib/fixtures/index.js'
import { setupLog, downloadLog } from './lib/log.js'
import { setupLocations } from './lib/locations.js'
import { setupFishing } from './lib/fishing.js'
import { setupItems } from './lib/item.js'
import { fetchInventory, setupInventory } from './lib/inventory.js'
import { setupPets } from './lib/pets.js'
import { setupPlayer } from './lib/player.js'
import { setupFarm } from './lib/farm.js'
import { setupPerks, fetchPerks } from './lib/perks.js'
import { setupOrchard } from './lib/orchard.js'
import { setupWheel } from './lib/wheel.js'
import { setupWorkshop } from './lib/workshop.js'
import { setupAnimals } from './lib/animals.js'

class GlobalState {
    constructor() {
        this.ports = []
        this.clickHandlers = {}
    }

    addPageFilter(url, handler) {
        setupPageFilter(url, async (page, url) => {
            await handler(this, page, url)
            await renderSidebar(this)
        })
    }

    addClickHandler(type, handler) {
        this.clickHandlers[type] = handler
    }

    postMessage(msg) {
        let lastError = null
        for (const port of [...this.ports]) {
            try {
                port.postMessage(msg)
            } catch(e) {
                console.error(e)
                lastError = e
                // Remove this port.
                port.disconnect() // Just in case?
                const i = this.ports.indexOf(port)
                if (i !== -1) {
                    this.ports.splice(i, 1)
                }
                // Keep trying the other ports.
            }
        }
        if (lastError !== null) {
            throw lastError
        }
    }
}

const globalState = new GlobalState()

const handleSidbarClick = async target => {
    console.log("sidebar click", target)
    const [targetType, targetArg] = target.split(":", 2)
    switch (targetType) {
    case "farm":
        if (globalState.player.farmID) {
            globalState.postMessage({ action: "RELOAD_VIEW", url: `xfarm.php?id=${globalState.player.farmID}`})
        } else {
            console.log("Can't navigate to farm without Farm ID")
        }
        break
    case "perk":
        globalState.perksetLoading = true
        await renderSidebarFromGlobalState()
        const nextPerkset = globalState.player.currentPerkset === "Farming" ? "Crafting" : "Farming"
        const nextPerksetId = globalState.player.perksets[nextPerkset]
        if (!nextPerksetId) {
            throw `Cannot find perkset ID for ${nextPerkset}`
        }
        let resp = await fetch("https://farmrpg.com/worker.php?go=resetperks", {method: "POST"})
        if (!resp.ok) {
            throw "Error reseting perks"
        }
        resp = await fetch(`https://farmrpg.com/worker.php?go=activateperkset&id=${nextPerksetId}`, {method: "POST"})
        if (!resp.ok) {
            throw "Error activating perkset"
        }
        globalState.player.currentPerkset = nextPerkset
        await globalState.player.save(globalState.db)
        globalState.perksetLoading = false
        await renderSidebarFromGlobalState()
        break
    case "log":
        await downloadLog(globalState)
        break
    default:
        if (globalState.clickHandlers[targetType]) {
            await globalState.clickHandlers[targetType](globalState, targetType, targetArg)
        }
        break
    }
}

const connectToContentScript = () =>
    new Promise(resolve =>
        browser.runtime.onConnect.addListener(port => {
            port.onDisconnect.addListener(disPort => {
                const i = globalState.ports.indexOf(disPort)
                if (i !== -1) {
                    globalState.ports.splice(i, 1)
                }
            })
            port.onMessage.addListener(msg => {
                switch (msg.action) {
                case "SIDEBAR_CLICK":
                    handleSidbarClick(msg.target)
                    break
                }
            })
            globalState.ports.push(port)
            // Get something rendered at least.
            renderSidebar(globalState)
            // The first time we get a connection, let the promise resolve.
            // This means we can block until we get at least one connection.
            if (resolve) {
                resolve(port)
                resolve = null
            }
        })
    )

const main = async () => {
    console.log("FarmRPG-Ext loaded (background)!")
    window.globalState = globalState
    await connectToContentScript()

    // A debugging helper to quickly clear the idb state.
    window.resetdb = async () => {
        if (globalState.db) {
            globalState.db.close()
        }
        await idb.deleteDB("farmrpg-ext")
    }

    // Make sure the DB is persisted.
    const persist = await navigator.storage.persist()
    if (!persist) {
        throw "Unable to set persist mode for storage"
    }

    // Initialize the database.
    globalState.db = await idb.openDB("farmrpg-ext", 2, {
        upgrade(db, oldVer) {
            switch(oldVer) {
            case 0:
                console.log("Running DB migrations for version 1")
                db.createObjectStore("log", { keyPath: "id", autoIncrement: true })
                const items = db.createObjectStore("items", { keyPath: "name" })
                items.createIndex("byImage", "image", {unique: false})
                items.createIndex("byID", "id", {unique: true})
                const locations = db.createObjectStore("locations", { keyPath: ["type", "name"] })
                locations.createIndex("byID", ["type", "id"], {unique: true})
            case 1:
                console.log("Running DB migrations for version 2")
                const pets = db.createObjectStore("pets", { keyPath: "name" })
                pets.createIndex("byID", "id", {unique: true})
                db.createObjectStore("player", { keyPath: "id", autoIncrement: true })
            }
        },
    })
    setupLog(globalState)
    await syncFixtures(globalState.db)
    const itemCount = await globalState.db.count("items")
    const locationCount = await globalState.db.count("locations")
    const logCount = await globalState.db.count("log")
    console.log(`Database loaded, items ${itemCount} locations ${locationCount} log ${logCount}`)

    // Munge outgoing requests to fix the origin and referer headers.
    browser.webRequest.onBeforeSendHeaders.addListener(
        details => {
            if (!details.originUrl.startsWith(`moz-extension://`)) {
                return
            }
            let sawReferer = false
            for(const header of details.requestHeaders) {
                if (header.name.toLowerCase() === "origin") {
                    header.value = "https://farmrpg.com"
                } else if (header.name.toLowerCase() === "referer") {
                    header.value = "https://farmrpg.com/index.php"
                    sawReferer = true
                }
            }
            if (!sawReferer) {
                details.requestHeaders.push({name: "Referer", value: "https://farmrpg.com/index.php"})
            }
            return {requestHeaders: details.requestHeaders}
        },
        { urls: ["*://*.farmrpg.com/*"] },
        ["blocking", "requestHeaders"]
    )

    // Setup page filters for data capture.
    await setupPlayer(globalState)
    setupItems(globalState)
    setupLocations(globalState)
    setupInventory(globalState)
    setupPets(globalState)
    setupExplore(globalState)
    setupFishing(globalState)
    setupFarm(globalState)
    setupPerks(globalState)
    setupOrchard(globalState)
    setupWheel(globalState)
    setupWorkshop(globalState)
    setupAnimals(globalState)

    // Kick off some initial data population.
    renderSidebarFromGlobalState()
    fetchInventory(globalState).then(renderSidebarFromGlobalState)
    fetchPerks().then(perks => {
        console.log("Found initial perksetId", perks.currentPerkset)
        globalState.player.perksets = perks.perksets
        globalState.player.currentPerkset = perks.currentPerkset
        globalState.player.save(globalState.db)
        renderSidebarFromGlobalState()
    })

    // Set up a periodic refresh of the inventory.
    browser.alarms.create("inventory-refresh", {periodInMinutes: 5})
    browser.alarms.create("perk-refresh", {periodInMinutes: 15})
    browser.alarms.create("render-sidebar", {periodInMinutes: 1})
    browser.alarms.onAlarm.addListener(async alarm => {
        switch (alarm.name) {
        case "inventory-refresh":
            await fetchInventory(globalState)
            await renderSidebarFromGlobalState()
            break
        case "perk-refresh":
            globalState.perksetId = await getPerksetId()
            await renderSidebarFromGlobalState()
            break
        case "render-sidebar":
            await renderSidebarFromGlobalState()
            break
        }
    })
}

main()


// https://farmrpg.com/worker.php?go=spin&type=Apples
// You got:<br/><img src='/img/items/8297.png' class='itemimg'><br/>Apples (x9)
