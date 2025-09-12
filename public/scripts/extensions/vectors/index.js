import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    getRequestHeaders,
    is_send_press,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    generateRaw,
    substituteParamsExtended,
} from '../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
    getContext,
    modules,
    renderExtensionTemplateAsync,
    doExtrasFetch, getApiUrl,
    openThirdPartyExtensionMenu,
} from '../../extensions.js';
import { collapseNewlines, registerDebugFunction } from '../../power-user.js';
import { SECRET_KEYS, secret_state } from '../../secrets.js';
import { getDataBankAttachments, getDataBankAttachmentsForSource, getFileAttachment } from '../../chats.js';
import { debounce, getStringHash as calculateHash, waitUntilCondition, onlyUnique, splitRecursive, trimToStartSentence, trimToEndSentence, escapeHtml } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { getSortedEntries } from '../../world-info.js';
import { textgen_types, textgenerationwebui_settings } from '../../textgen-settings.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { slashCommandReturnHelper } from '../../slash-commands/SlashCommandReturnHelper.js';
import { generateWebLlmChatPrompt, isWebLlmSupported } from '../shared.js';
import { WebLlmVectorProvider } from './webllm.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { oai_settings } from '../../openai.js';

/**
 * @typedef {object} HashedMessage
 * @property {string} text - The hashed message text
 * @property {number} hash - The hash used as the vector key
 * @property {number} index - The index of the message in the chat
 */

const MODULE_NAME = 'vectors';

export const EXTENSION_PROMPT_TAG = '3_vectors';
export const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';

// Force solo chunks for sources that don't support batching.
const getBatchSize = () => ['transformers', 'ollama'].includes(settings.source) ? 1 : 5;

const settings = {
    // For both
    source: 'transformers',
    alt_endpoint_url: '',
    use_alt_endpoint: false,
    include_wi: false,
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    cohere_model: 'embed-english-v3.0',
    ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    vllm_model: '',
    webllm_model: '',
    google_model: 'text-embedding-004',
    summarize: false,
    summarize_sent: false,
    summary_source: 'main',
    summary_prompt: 'Ignore previous instructions. Summarize the most important parts of the message. Limit yourself to 250 words or less. Your response should include nothing but the summary.',
    force_chunk_delimiter: '',

    // For chats
    enabled_chats: false,
    augment_keyword_search: false,
    template: 'Past events:\n{{text}}',
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 3,
    query: 2,
    message_chunk_size: 400,
    score_threshold: 0.25,

    // For files
    enabled_files: false,
    translate_files: false,
    size_threshold: 10,
    chunk_size: 5000,
    chunk_count: 2,
    overlap_percent: 0,
    only_custom_boundary: false,

    // For Data Bank
    size_threshold_db: 5,
    chunk_size_db: 2500,
    chunk_count_db: 5,
    overlap_percent_db: 0,
    file_template_db: 'Related information:\n{{text}}',
    file_position_db: extension_prompt_types.IN_PROMPT,
    file_depth_db: 4,
    file_depth_role_db: extension_prompt_roles.SYSTEM,

    // For World Info
    enabled_world_info: false,
    enabled_for_all: false,
    max_entries: 5,
};

const moduleWorker = new ModuleWorkerWrapper(synchronizeChat);
const webllmProvider = new WebLlmVectorProvider();
const cachedSummaries = new Map();
const queryAnalysisCache = new Map(); // Cache for query analysis to avoid re-processing
const vectorApiRequiresUrl = ['llamacpp', 'vllm', 'ollama', 'koboldcpp'];

// Scoring constants
const SCORING_WEIGHTS = {
    KEYWORD: 0.3,
    PHRASE: 0.4,
    TECHNICAL: 0.5,
    PROXIMITY: 2.0,
    INTERSECTION_BONUS: 0.05,
    NORMALIZATION_SCALE: 0.5,
    DEFAULT_SEMANTIC_SCORE: 0.5,
    SEMANTIC_DECAY: 0.05,
};

// Search limits
const SEARCH_LIMITS = {
    MAX_SEARCH_TERMS: 20,
    MAX_WORDS_FOR_COMBINATIONS: 10,
    MAX_CHUNKS_TO_SEARCH: 50,
    SEMANTIC_SEARCH_MULTIPLIER: 2,
};

/**
 * Cache for file chunks to avoid re-fetching and re-splitting the same files
 * @type {Map<string, {chunks: string[], lastModified: number}>}
 */
const fileChunkCache = new Map();

/**
 * Cache for target file lookups to avoid repeated find operations
 * @type {Map<string, object>}
 */
const targetFileCache = new Map();

/**
 * Constants for word processing and query analysis
 * Moved to module level to avoid recreation on each function call
 */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'shall',
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me',
    'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'what', 'which',
    'who', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'don', 'now',
]);

const QUERY_STRUCTURE_WORDS = new Set(['tell', 'me', 'about', 'what', 'how', 'why', 'when', 'where', 'who', 'which', 'can', 'you', 'please', 'explain', 'describe']);

const COMMON_PHRASES = ['what is', 'how to', 'tell me', 'can you'];

const QUESTION_WORDS = ['what', 'how', 'why', 'when', 'where', 'who', 'which'];

/**
 * Cache for word processing results to avoid repeated computations
 * @type {Map<string, boolean>}
 */
const wordProcessingCache = new Map();

/**
 * Maximum size for word processing cache to prevent memory issues
 */
const WORD_PROCESSING_CACHE_MAX_SIZE = 1000;

/**
 * Gets the Collection ID for a file embedded in the chat.
 * @param {string} fileUrl URL of the file
 * @returns {string} Collection ID
 */
function getFileCollectionId(fileUrl) {
    return `file_${getStringHash(fileUrl)}`;
}

async function onVectorizeAllClick() {
    try {
        if (!settings.enabled_chats) {
            return;
        }

        const chatId = getCurrentChatId();

        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        // Clear all cached summaries to ensure that new ones are created
        // upon request of a full vectorise
        cachedSummaries.clear();

        const batchSize = getBatchSize();
        const elapsedLog = [];
        let finished = false;
        $('#vectorize_progress').show();
        $('#vectorize_progress_percent').text('0');
        $('#vectorize_progress_eta').text('...');

        while (!finished) {
            if (is_send_press) {
                toastr.info('Message generation is in progress.', 'Vectorization aborted');
                throw new Error('Message generation is in progress.');
            }

            const startTime = Date.now();
            const remaining = await synchronizeChat(batchSize);
            const elapsed = Date.now() - startTime;
            elapsedLog.push(elapsed);
            finished = remaining <= 0;

            const total = getContext().chat.length;
            const processed = total - remaining;
            const processedPercent = Math.round((processed / total) * 100); // percentage of the work done
            const lastElapsed = elapsedLog.slice(-5); // last 5 elapsed times
            const averageElapsed = lastElapsed.reduce((a, b) => a + b, 0) / lastElapsed.length; // average time needed to process one item
            const pace = averageElapsed / batchSize; // time needed to process one item
            const remainingTime = Math.round(pace * remaining / 1000);

            $('#vectorize_progress_percent').text(processedPercent);
            $('#vectorize_progress_eta').text(remainingTime);

            if (chatId !== getCurrentChatId()) {
                throw new Error('Chat changed');
            }
        }
    } catch (error) {
        console.error('Vectors: Failed to vectorize all', error);
    } finally {
        $('#vectorize_progress').hide();
    }
}

let syncBlocked = false;

/**
 * Gets the chunk delimiters for splitting text.
 * @returns {string[]} Array of chunk delimiters
 */
function getChunkDelimiters() {
    const delimiters = ['\n\n', '\n', ' ', ''];

    if (settings.force_chunk_delimiter) {
        delimiters.unshift(settings.force_chunk_delimiter);
    }

    return delimiters;
}

/**
 * Splits messages into chunks before inserting them into the vector index.
 * @param {object[]} items Array of vector items
 * @returns {object[]} Array of vector items (possibly chunked)
 */
function splitByChunks(items) {
    if (settings.message_chunk_size <= 0) {
        return items;
    }

    const chunkedItems = [];

    for (const item of items) {
        const chunks = splitRecursive(item.text, settings.message_chunk_size, getChunkDelimiters());
        for (const chunk of chunks) {
            const chunkedItem = { ...item, text: chunk };
            chunkedItems.push(chunkedItem);
        }
    }

    return chunkedItems;
}

/**
 * Summarizes messages using the Extras API method.
 * @param {HashedMessage} element hashed message
 * @returns {Promise<boolean>} Sucess
 */
async function summarizeExtra(element) {
    try {
        const url = new URL(getApiUrl());
        url.pathname = '/api/summarize';

        const apiResult = await doExtrasFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Bypass-Tunnel-Reminder': 'bypass',
            },
            body: JSON.stringify({
                text: element.text,
                params: {},
            }),
        });

        if (apiResult.ok) {
            const data = await apiResult.json();
            element.text = data.summary;
        }
    }
    catch (error) {
        console.error('[Vectors] Summarize extra error:', error);
        return false;
    }

    return true;
}

/**
 * Summarizes messages using the main API method.
 * @param {HashedMessage} element hashed message
 * @returns {Promise<boolean>} Success
 */
async function summarizeMain(element) {
    element.text = removeReasoningFromString(await generateRaw({ prompt: element.text, systemPrompt: settings.summary_prompt }));
    return true;
}

/**
 * Summarizes messages using WebLLM.
 * @param {HashedMessage} element hashed message
 * @returns {Promise<boolean>} Success
 */
async function summarizeWebLLM(element) {
    if (!isWebLlmSupported()) {
        console.warn('Vectors: WebLLM is not supported');
        return false;
    }

    const messages = [{ role: 'system', content: settings.summary_prompt }, { role: 'user', content: element.text }];
    element.text = await generateWebLlmChatPrompt(messages);

    return true;
}

/**
 * Summarizes messages using the chosen method.
 * @param {HashedMessage[]} hashedMessages Array of hashed messages
 * @param {string} endpoint Type of endpoint to use
 * @returns {Promise<HashedMessage[]>} Summarized messages
 */
async function summarize(hashedMessages, endpoint = 'main') {
    for (const element of hashedMessages) {
        const cachedSummary = cachedSummaries.get(element.hash);
        if (!cachedSummary) {
            let success = true;
            switch (endpoint) {
                case 'main':
                    success = await summarizeMain(element);
                    break;
                case 'extras':
                    success = await summarizeExtra(element);
                    break;
                case 'webllm':
                    success = await summarizeWebLLM(element);
                    break;
                default:
                    console.error('Unsupported endpoint', endpoint);
                    success = false;
                    break;
            }
            if (success) {
                cachedSummaries.set(element.hash, element.text);
            } else {
                break;
            }
        } else {
            element.text = cachedSummary;
        }
    }
    return hashedMessages;
}

async function synchronizeChat(batchSize = 5) {
    if (!settings.enabled_chats) {
        return -1;
    }

    try {
        await waitUntilCondition(() => !syncBlocked && !is_send_press, 1000);
    } catch {
        console.warn('[Vectors] Synchronization blocked by another process');
        return -1;
    }

    try {
        syncBlocked = true;
        const context = getContext();
        const chatId = getCurrentChatId();

        if (!chatId || !Array.isArray(context.chat)) {
            console.warn('Vectors: No chat selected');
            return -1;
        }

        const hashedMessages = context.chat.filter(x => !x.is_system).map(x => ({ text: String(substituteParams(x.mes)), hash: getStringHash(substituteParams(x.mes)), index: context.chat.indexOf(x) }));
        const hashesInCollection = await getSavedHashes(chatId);

        let newVectorItems = hashedMessages.filter(x => !hashesInCollection.includes(x.hash));
        const deletedHashes = hashesInCollection.filter(x => !hashedMessages.some(y => y.hash === x));

        if (settings.summarize) {
            newVectorItems = await summarize(newVectorItems, settings.summary_source);
        }

        if (newVectorItems.length > 0) {
            const chunkedBatch = splitByChunks(newVectorItems.slice(0, batchSize));

            console.debug(`[Vectors] Found ${newVectorItems.length} new items. Processing ${batchSize}...`);
            await insertVectorItems(chatId, chunkedBatch);
        }

        if (deletedHashes.length > 0) {
            await deleteVectorItems(chatId, deletedHashes);
            console.log(`[Vectors] Deleted ${deletedHashes.length} old hashes`);
        }

        return newVectorItems.length - batchSize;
    } catch (error) {
        /**
         * Gets the error message for a given cause
         * @param {string} cause Error cause key
         * @returns {string} Error message
         */
        function getErrorMessage(cause) {
            switch (cause) {
                case 'api_key_missing':
                    return 'API key missing. Save it in the "API Connections" panel.';
                case 'api_url_missing':
                    return 'API URL missing. Save it in the "API Connections" panel.';
                case 'api_model_missing':
                    return 'Vectorization Source Model is required, but not set.';
                case 'extras_module_missing':
                    return 'Extras API must provide an "embeddings" module.';
                case 'webllm_not_supported':
                    return 'WebLLM extension is not installed or the model is not set.';
                default:
                    return 'Check server console for more details';
            }
        }

        console.error('Vectors: Failed to synchronize chat', error);

        const message = getErrorMessage(error.cause);
        toastr.error(message, 'Vectorization failed', { preventDuplicates: true });
        return -1;
    } finally {
        syncBlocked = false;
    }
}

/**
 * @type {Map<string, number>} Cache object for storing hash values
 */
const hashCache = new Map();

/**
 * Gets the hash value for a given string
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    // Check if the hash is already in the cache
    if (hashCache.has(str)) {
        return hashCache.get(str);
    }

    // Calculate the hash value
    const hash = calculateHash(str);

    // Store the hash in the cache
    hashCache.set(str, hash);

    return hash;
}

/**
 * Retrieves files from the chat and inserts them into the vector index.
 * @param {object[]} chat Array of chat messages
 * @returns {Promise<void>}
 */
async function processFiles(chat) {
    try {
        if (!settings.enabled_files) {
            return;
        }

        const dataBankCollectionIds = await ingestDataBankAttachments();

        if (dataBankCollectionIds.length) {
            const queryText = await getQueryText(chat, 'file');
            await injectDataBankChunks(queryText, dataBankCollectionIds);
        }

        for (const message of chat) {
            // Message has no file
            if (!message?.extra?.file) {
                continue;
            }

            // Trim file inserted by the script
            const fileText = String(message.mes)
                .substring(0, message.extra.fileLength).trim();

            // Convert kilobytes to string length
            const thresholdLength = settings.size_threshold * 1024;

            // File is too small
            if (fileText.length < thresholdLength) {
                continue;
            }

            message.mes = message.mes.substring(message.extra.fileLength);

            const fileName = message.extra.file.name;
            const fileUrl = message.extra.file.url;
            const collectionId = getFileCollectionId(fileUrl);
            const hashesInCollection = await getSavedHashes(collectionId);

            // File is already in the collection
            if (!hashesInCollection.length) {
                await vectorizeFile(fileText, fileName, collectionId, settings.chunk_size, settings.overlap_percent);
            }

            const queryText = await getQueryText(chat, 'file');
            const fileChunks = await retrieveFileChunks(queryText, collectionId);

            message.mes = `${fileChunks}\n\n${message.mes}`;
        }
    } catch (error) {
        console.error('Vectors: Failed to retrieve files', error);
    }
}

/**
 * Ensures that data bank attachments are ingested and inserted into the vector index.
 * @param {string} [source] Optional source filter for data bank attachments.
 * @returns {Promise<string[]>} Collection IDs
 */
async function ingestDataBankAttachments(source) {
    // Exclude disabled files
    const dataBank = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
    const dataBankCollectionIds = [];

    for (const file of dataBank) {
        const collectionId = getFileCollectionId(file.url);
        const hashesInCollection = await getSavedHashes(collectionId);
        dataBankCollectionIds.push(collectionId);

        // File is already in the collection
        if (hashesInCollection.length) {
            continue;
        }

        // Download and process the file
        const fileText = await getFileAttachment(file.url);
        console.debug(`[Vectors] Retrieved file ${file.name} from Data Bank`);
        // Convert kilobytes to string length
        const thresholdLength = settings.size_threshold_db * 1024;
        // Use chunk size from settings if file is larger than threshold
        const chunkSize = file.size > thresholdLength ? settings.chunk_size_db : -1;
        await vectorizeFile(fileText, file.name, collectionId, chunkSize, settings.overlap_percent_db);
    }

    return dataBankCollectionIds;
}

/**
 * Inserts file chunks from the Data Bank into the prompt.
 * @param {string} queryText Text to query
 * @param {string[]} collectionIds File collection IDs
 * @returns {Promise<void>}
 */
async function injectDataBankChunks(queryText, collectionIds) {
    try {
        // Removed duplicate query text logging - already logged in processFiles

        // Now try with normal threshold - USE SMART SEARCH
        const searchType = settings.augment_keyword_search ? 'enhanced' : 'basic';
        console.debug(`[Vectors] Running ${searchType} search for data bank`);
        const queryResults = {};

        // Use smart search for each collection individually
        for (const collectionId of collectionIds) {
            console.debug(`[Vectors] Querying collection ${collectionId} with ${searchType} search`);
            const collectionResults = await smartQueryCollection(collectionId, queryText, settings.chunk_count_db, settings.score_threshold);
            console.debug(`[Vectors] Raw API response for ${collectionId}:`, JSON.stringify(collectionResults, null, 2));
            queryResults[collectionId] = collectionResults;
        }

        console.debug(`[Vectors] Retrieved ${collectionIds.length} Data Bank collections with ${searchType} search`, queryResults);

        // Add detailed logging
        if (queryResults && Object.keys(queryResults).length > 0) {
            for (const [collectionId, result] of Object.entries(queryResults)) {
                console.debug(`[Vectors] Collection ${collectionId}: ${result.hashes?.length || 0} chunks`);
            }
        }

        let textResult = '';

        for (const collectionId in queryResults) {
            console.debug(`[Vectors] Processing Data Bank collection ${collectionId}`, queryResults[collectionId]);

            // Get the original metadata objects (not just text)
            const originalMetadata = queryResults[collectionId].metadata?.filter(x => x.text) || [];
            console.debug(`[Vectors] Original metadata for ${collectionId}:`, originalMetadata);

            // Sort by index and remove duplicates based on text content
            const sortedMetadata = originalMetadata
                .sort((a, b) => a.index - b.index)
                .filter((item, index, arr) => arr.findIndex(x => x.text === item.text) === index);

            console.debug(`[Vectors] Sorted metadata for ${collectionId}:`, sortedMetadata);

            // DEBUG: Log chunk details with API scores
            console.debug(`[Vectors] Collection ${collectionId} - Retrieved ${sortedMetadata.length} chunks`);
            let totalChunkSize = 0;
            sortedMetadata.forEach((chunkMetadata, i) => {
                const apiScore = chunkMetadata?.score !== undefined ? chunkMetadata.score.toFixed(4) : 'N/A';
                console.debug(`[Vectors]   Chunk ${i + 1}: ${chunkMetadata.text.length} characters (API score: ${apiScore})`);
                totalChunkSize += chunkMetadata.text.length;
            });
            console.debug(`[Vectors]   Total chunk content: ${totalChunkSize} characters`);

            // Extract text for the final result
            const metadata = sortedMetadata.map(x => x.text);
            textResult += metadata.join('\n') + '\n\n';
        }

        // DEBUG: Log final result size
        console.debug(`[Vectors] Final textResult size: ${textResult.length} characters`);
        console.debug(`[Vectors] Expected max size: ${settings.chunk_count_db} chunks × ${settings.chunk_size_db} chars = ${settings.chunk_count_db * settings.chunk_size_db} chars`);

        if (!textResult) {
            console.log('[Vectors] No Data Bank chunks found');
            return;
        }

        const insertedText = substituteParamsExtended(settings.file_template_db, { text: textResult });
        setExtensionPrompt(EXTENSION_PROMPT_TAG_DB, insertedText, settings.file_position_db, settings.file_depth_db, settings.include_wi, settings.file_depth_role_db);
    } catch (error) {
        console.error('Vectors: Failed to insert Data Bank chunks', error);
    }
}

/**
 * Retrieves file chunks from the vector index and inserts them into the chat.
 * @param {string} queryText Text to query
 * @param {string} collectionId File collection ID
 * @returns {Promise<string>} Retrieved file text
 */
async function retrieveFileChunks(queryText, collectionId) {
    console.debug(`Vectors: Retrieving file chunks for collection ${collectionId}`, queryText);
    // Reset threshold and try normal query
    const queryResults = await queryCollection(collectionId, queryText, settings.chunk_count, settings.score_threshold);
    console.debug(`Vectors: Retrieved ${queryResults.hashes.length} file chunks for collection ${collectionId}`, queryResults);

    // Add detailed logging of chunk contents
    if (queryResults.metadata && queryResults.metadata.length > 0) {
        console.debug('[Vectors] Normal threshold file results:');
    }

    const metadata = queryResults.metadata.filter(x => x.text).sort((a, b) => a.index - b.index).map(x => x.text).filter(onlyUnique);
    const fileText = metadata.join('\n');

    return fileText;
}

/**
 * Vectorizes a file and inserts it into the vector index.
 * @param {string} fileText File text
 * @param {string} fileName File name
 * @param {string} collectionId File collection ID
 * @param {number} chunkSize Chunk size
 * @param {number} overlapPercent Overlap size (in %)
 * @returns {Promise<boolean>} True if successful, false if not
 */
async function vectorizeFile(fileText, fileName, collectionId, chunkSize, overlapPercent) {
    let toast = jQuery();

    try {
        if (settings.translate_files && typeof globalThis.translate === 'function') {
            console.debug(`[Vectors] Translating file ${fileName} to English...`);
            const translatedText = await globalThis.translate(fileText, 'en');
            fileText = translatedText;
        }

        const batchSize = getBatchSize();
        const toastBody = $('<span>').text('This may take a while. Please wait...');
        toast = toastr.info(toastBody, `Ingesting file ${escapeHtml(fileName)}`, { closeButton: false, escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
        const overlapSize = Math.round(chunkSize * overlapPercent / 100);
        const delimiters = getChunkDelimiters();
        // Overlap should not be included in chunk size. It will be later compensated by overlapChunks
        chunkSize = overlapSize > 0 ? (chunkSize - overlapSize) : chunkSize;
        const applyOverlap = (x, y, z) => overlapSize > 0 ? overlapChunks(x, y, z, overlapSize) : x;
        const chunks = settings.only_custom_boundary && settings.force_chunk_delimiter
            ? fileText.split(settings.force_chunk_delimiter).map(applyOverlap)
            : splitRecursive(fileText, chunkSize, delimiters).map(applyOverlap);

        // 🔍 DEBUG: Log chunking details
        console.debug(`[Vectors] Chunking analysis for ${fileName}`);
        console.debug(`[Vectors] Original text length: ${fileText.length}`);
        console.debug(`[Vectors] Chunk size: ${chunkSize}, Overlap: ${overlapPercent}% (${overlapSize} chars)`);
        console.debug(`[Vectors] Delimiters: ${JSON.stringify(delimiters)}`);
        console.debug(`[Vectors] Total chunks created: ${chunks.length}`);

        // Log first few chunks for inspection
        chunks.slice(0, 3).forEach((chunk, index) => {
            console.debug(`[Vectors] Chunk ${index + 1} preview: "${chunk.substring(0, 100)}..."`);
        });

        console.debug(`Vectors: Split file ${fileName} into ${chunks.length} chunks with ${overlapPercent}% overlap`, chunks);

        const items = chunks.map((chunk, index) => ({ hash: getStringHash(chunk), text: chunk, index: index }));

        for (let i = 0; i < items.length; i += batchSize) {
            toastBody.text(`${i}/${items.length} (${Math.round((i / items.length) * 100)}%) chunks processed`);
            const chunkedBatch = items.slice(i, i + batchSize);
            await insertVectorItems(collectionId, chunkedBatch);
        }

        toastr.clear(toast);
        console.log(`[Vectors] Inserted ${chunks.length} vector items for file ${fileName} into ${collectionId}`);
        return true;
    } catch (error) {
        toastr.clear(toast);
        toastr.error(String(error), 'Failed to vectorize file', { preventDuplicates: true });
        console.error('Vectors: Failed to vectorize file', error);
        return false;
    }
}

/**
 * Removes the most relevant messages from the chat and displays them in the extension prompt
 * @param {object[]} chat Array of chat messages
 * @param {number} _contextSize Context size (unused)
 * @param {function} _abort Abort function (unused)
 * @param {string} type Generation type
 */
async function rearrangeChat(chat, _contextSize, _abort, type) {
    try {
        if (type === 'quiet') {
            console.debug('Vectors: Skipping quiet prompt');
            return;
        }

        // Clear the extension prompt
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, settings.include_wi);
        setExtensionPrompt(EXTENSION_PROMPT_TAG_DB, '', settings.file_position_db, settings.file_depth_db, settings.include_wi, settings.file_depth_role_db);

        if (settings.enabled_files) {
            await processFiles(chat);
        }

        if (settings.enabled_world_info) {
            await activateWorldInfo(chat);
        }

        if (!settings.enabled_chats) {
            return;
        }

        const chatId = getCurrentChatId();

        if (!chatId || !Array.isArray(chat)) {
            console.warn('Vectors: No chat selected');
            return;
        }

        if (chat.length < settings.protect) {
            console.log(`Vectors: Not enough messages to rearrange (less than ${settings.protect})`);
            return;
        }

        const queryText = await getQueryText(chat, 'chat');

        if (queryText.length === 0) {
            console.log('Vectors: No text to query');
            return;
        }

        // Get the most relevant messages, excluding the last few
        const queryResults = await queryCollection(chatId, queryText, settings.insert);
        const queryHashes = queryResults.hashes.filter(onlyUnique);
        const queriedMessages = [];
        const insertedHashes = new Set();
        const retainMessages = chat.slice(-settings.protect);

        for (const message of chat) {
            if (retainMessages.includes(message) || !message.mes) {
                continue;
            }
            const hash = getStringHash(substituteParams(message.mes));
            if (queryHashes.includes(hash) && !insertedHashes.has(hash)) {
                queriedMessages.push(message);
                insertedHashes.add(hash);
            }
        }

        // Rearrange queried messages to match query order
        // Order is reversed because more relevant are at the lower indices
        queriedMessages.sort((a, b) => queryHashes.indexOf(getStringHash(substituteParams(b.mes))) - queryHashes.indexOf(getStringHash(substituteParams(a.mes))));

        // Remove queried messages from the original chat array
        for (const message of chat) {
            if (queriedMessages.includes(message)) {
                chat.splice(chat.indexOf(message), 1);
            }
        }

        if (queriedMessages.length === 0) {
            console.debug('Vectors: No relevant messages found');
            return;
        }

        // Format queried messages into a single string
        const insertedText = getPromptText(queriedMessages);
        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, settings.position, settings.depth, settings.include_wi);
    } catch (error) {
        toastr.error('Generation interceptor aborted. Check browser console for more details.', 'Vector Storage');
        console.error('Vectors: Failed to rearrange chat', error);
    }
}

/**
 * @param {any[]} queriedMessages
 * @returns {string}
 */
function getPromptText(queriedMessages) {
    const queriedText = queriedMessages.map(x => collapseNewlines(`${x.name}: ${x.mes}`).trim()).join('\n\n');
    console.log('[Vectors] Relevant past messages found.\n', queriedText);
    return substituteParamsExtended(settings.template, { text: queriedText });
}

/**
 * Modifies text chunks to include overlap with adjacent chunks.
 * @param {string} chunk Current item
 * @param {number} index Current index
 * @param {string[]} chunks List of chunks
 * @param {number} overlapSize Size of the overlap
 * @returns {string} Overlapped chunks, with overlap trimmed to sentence boundaries
 */
function overlapChunks(chunk, index, chunks, overlapSize) {
    const halfOverlap = Math.floor(overlapSize / 2);
    const nextChunk = chunks[index + 1];
    const prevChunk = chunks[index - 1];

    const nextOverlap = trimToEndSentence(nextChunk?.substring(0, halfOverlap)) || '';
    const prevOverlap = trimToStartSentence(prevChunk?.substring(prevChunk.length - halfOverlap)) || '';
    const overlappedChunk = [prevOverlap, chunk, nextOverlap].filter(x => x).join(' ');

    return overlappedChunk;
}

window['vectors_rearrangeChat'] = rearrangeChat;

const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

// Make cache management functions available globally for debugging
window['clearFileChunkCache'] = clearFileChunkCache;
window['getFileChunkCacheInfo'] = () => {
    console.debug('[Vectors] File Chunk Cache Info:');
    console.debug(`[Vectors] Total cached files: ${fileChunkCache.size}`);
    for (const [collectionId, data] of fileChunkCache.entries()) {
        console.debug(`[Vectors] - ${collectionId}: ${data.chunks.length} chunks, cached ${new Date(data.lastModified).toLocaleTimeString()}`);
    }
    return fileChunkCache.size;
};
window['clearQueryAnalysisCache'] = () => {
    queryAnalysisCache.clear();
    console.debug('[Vectors] Query analysis cache cleared');
};
window['getQueryAnalysisCacheInfo'] = () => {
    console.debug('[Vectors] Query Analysis Cache Info:');
    console.debug(`[Vectors] Total cached queries: ${queryAnalysisCache.size}`);
    return queryAnalysisCache.size;
};
window['clearWordProcessingCache'] = () => {
    wordProcessingCache.clear();
    console.debug('[Vectors] Word processing cache cleared');
};
window['getWordProcessingCacheInfo'] = () => {
    console.debug('[Vectors] Word Processing Cache Info:');
    console.debug(`[Vectors] Total cached words: ${wordProcessingCache.size}`);
    return wordProcessingCache.size;
};

/**
 * Gets cached chunks for a collection, or fetches and caches them if not available
 * @param {string} collectionId - Collection ID to get chunks for
 * @returns {Promise<string[]|null>} - Array of chunks or null if failed
 */
async function getCachedFileChunks(collectionId) {
    const cacheKey = collectionId;

    // Check if chunks are already cached
    if (fileChunkCache.has(cacheKey)) {
        return fileChunkCache.get(cacheKey).chunks;
    }

    // Fetch and cache chunks
    const dataBank = getDataBankAttachments();
    const targetFile = dataBank.find(attachment => getFileCollectionId(attachment.url) === collectionId);

    if (!targetFile) {
        console.debug('[Vectors] Source file not found in dataBank');
        return null;
    }

    try {
        const response = await fetch(targetFile.url);
        if (!response.ok) {
            console.warn('Failed to fetch file content');
            return null;
        }

        const fileContent = await response.text();
        console.debug(`[Vectors] Read ${fileContent.length} characters from file`);

        // Split into chunks using same parameters as vector system
        const delimiters = getChunkDelimiters();
        const chunkSize = settings.chunk_size_db;
        const overlapPercent = settings.overlap_percent_db;
        const overlapSize = Math.floor(chunkSize * overlapPercent / 100);
        const adjustedChunkSize = overlapSize > 0 ? (chunkSize - overlapSize) : chunkSize;
        const applyOverlap = (chunk, index, chunks) => overlapSize > 0 ? overlapChunks(chunk, index, chunks, overlapSize) : chunk;

        const rawChunks = splitRecursive(fileContent, adjustedChunkSize, delimiters);
        const chunks = rawChunks.map(applyOverlap);

        console.debug(`[Vectors] Split into ${chunks.length} chunks (size: ${chunkSize}, overlap: ${overlapPercent}%)`);

        // Cache the chunks
        fileChunkCache.set(cacheKey, {
            chunks: chunks,
            lastModified: Date.now(),
        });

        return chunks;
    } catch (error) {
        console.warn('Failed to fetch and cache file chunks:', error);
        return null;
    }
}

/**
 * Clears the file chunk cache (useful for memory management or when files change)
 * @param {string} [collectionId] - Optional specific collection to clear, clears all if not provided
 */
function clearFileChunkCache(collectionId = null) {
    if (collectionId) {
        fileChunkCache.delete(collectionId);
        targetFileCache.delete(collectionId); // Also clear target file cache
        console.debug(`[Vectors] Cleared cache for collection: ${collectionId}`);
    } else {
        const cacheSize = fileChunkCache.size;
        const targetCacheSize = targetFileCache.size;
        fileChunkCache.clear();
        targetFileCache.clear(); // Also clear target file cache
        console.debug(`[Vectors] Cleared entire file chunk cache (${cacheSize} entries) and target file cache (${targetCacheSize} entries)`);
    }
}

async function exactKeywordSearch(collectionId, keyword, maxResults = 10, originalQuery = '') {
    console.debug(`[Vectors] Performing exact keyword search for "${keyword}"`);

    try {
        // Check cache for target file first
        let targetFile = targetFileCache.get(collectionId);

        if (!targetFile) {
            const dataBank = getDataBankAttachments();
            targetFile = dataBank.find(attachment => getFileCollectionId(attachment.url) === collectionId);

            // Cache the result if found
            if (targetFile) {
                targetFileCache.set(collectionId, targetFile);
                console.debug(`[Vectors] Cached target file for collection ${collectionId}: ${targetFile.url}`);
            }
        } else {
            console.debug(`[Vectors] Using cached target file for collection ${collectionId}: ${targetFile.url}`);
        }

        if (targetFile) {
            // Get chunks from cache or fetch/cache them
            const chunks = await getCachedFileChunks(collectionId);

            if (!chunks) {
                console.warn('Failed to get file chunks');
                return { hashes: [], metadata: [] };
            }

            const exactMatches = [];
            const seenHashes = new Set();

            // Search through all chunks
            for (let i = 0; i < chunks.length; i++) {
                const chunkText = chunks[i];

                // Debug: Log first few chunks (only on first search of this file)
                if (i < 3 && !fileChunkCache.has(collectionId)) {
                    console.debug(`[Vectors] FILE Chunk ${i}: "${chunkText.substring(0, 100)}..."`);
                }

                // Check for exact case-insensitive match
                if (chunkText.toLowerCase().includes(keyword.toLowerCase())) {
                    const hash = calculateHash(chunkText); // Generate hash for the chunk
                    if (!seenHashes.has(hash)) {
                        seenHashes.add(hash);
                        console.debug(`[Vectors] FOUND MATCH in file chunk ${i}:`);
                        console.debug(`[Vectors] FULL TEXT: "${chunkText.substring(0, 100)}..."`);
                        console.debug(`[Vectors] Keyword "${keyword}" found at position: ${chunkText.toLowerCase().indexOf(keyword.toLowerCase())}`);
                        exactMatches.push({
                            hash: hash,
                            text: chunkText,
                            index: i,
                        });

                        if (exactMatches.length >= maxResults) break;
                    }
                }
            }

            console.debug(`[Vectors] Found ${exactMatches.length} exact matches in file`);
            return {
                hashes: exactMatches.map(match => match.hash),
                metadata: exactMatches.map(match => ({
                    text: match.text,
                    index: match.index,
                    score: 1.0,
                })),
            };
        } else {
            console.debug('[Vectors] Source file not found in dataBank, falling back to vector search');
        }

        // FALLBACK: Original vector-based approach if direct file reading fails
        // Use multiple approaches to get diverse chunks to search through for exact keyword matches

        let allChunks = { hashes: [], metadata: [] };

        const exactMatches = [];
        const seenHashes = new Set();

        // Filter for exact matches
        console.debug(`[Vectors] FINAL: Searching through ${allChunks.hashes.length} total chunks for "${keyword}"`);
        for (let i = 0; i < allChunks.hashes.length && i < allChunks.metadata.length; i++) {
            const hash = allChunks.hashes[i];
            const metadata = allChunks.metadata[i];
            const chunkText = metadata?.text || '';

            // Debug: Log first 3, last 3, and any matches
            const shouldLog = i < 3 || i >= allChunks.hashes.length - 3;
            if (shouldLog) {
                console.debug(`[Vectors] DEBUG Chunk ${i}: "${chunkText.substring(0, 100)}..."`);
            }

            // Check for exact case-insensitive match
            if (chunkText.toLowerCase().includes(keyword.toLowerCase()) && !seenHashes.has(hash)) {
                seenHashes.add(hash);
                console.debug(`[Vectors] FOUND MATCH at chunk ${i}: "${chunkText.substring(0, 200)}..."`);
                exactMatches.push({
                    hash: hash,
                    text: chunkText,
                    index: metadata?.index || i,
                });

                if (exactMatches.length >= maxResults) break;
            }
        }

        console.debug(`[Vectors] Found ${exactMatches.length} exact matches for "${keyword}" from ${allChunks.hashes.length} total chunks searched`);

        return {
            hashes: exactMatches.map(match => match.hash),
            metadata: exactMatches.map(match => ({
                text: match.text,
                index: match.index,
                score: 1.0, // Exact matches get perfect score
            })),
        };

    } catch (error) {
        console.error('Exact keyword search failed:', error);
        return { hashes: [], metadata: [] };
    }
}

/**
 * Enhanced query function that automatically applies intelligent hybrid search
 * @param {string} collectionId - Collection ID to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold for results (optional, uses settings.score_threshold if not provided)
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Results using intelligent search
 */

//MARK: smartQueryCollection
async function smartQueryCollection(collectionId, searchText, topK = 5, threshold = null) {
    // Use provided threshold or fall back to settings
    const effectiveThreshold = threshold !== null ? threshold : settings.score_threshold;

    // Check if keyword search augmentation is enabled
    if (!settings.augment_keyword_search) {
        // Use basic semantic search without enhancements - minimal logging to prevent spam
        return await queryCollectionBasic(collectionId, searchText, topK, effectiveThreshold);
    }

    console.debug(`[Vectors] smartQueryCollection: "${searchText}" with threshold ${effectiveThreshold}, topK ${topK}`);

    // Analyze the query to understand its structure and intent
    const queryAnalysis = analyzeQuery(searchText);

    console.debug(`[Vectors] Query analysis for "${searchText}":`);
    console.debug(`[Vectors]   Keywords: ${queryAnalysis.keywords.join(', ')}`);
    console.debug(`[Vectors]   Key phrases: ${queryAnalysis.keyPhrases.join(', ')}`);
    console.debug(`[Vectors]   Technical terms: ${queryAnalysis.technicalTerms.join(', ')}`);

    // Use intelligent hybrid search for all queries (includes both semantic and keyword search)
    return await intelligentHybridSearch(collectionId, searchText, queryAnalysis, topK, effectiveThreshold);
}

/**
 * Basic semantic search without enhancements - calls the vector API directly
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {number} threshold - Score threshold (optional)
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Query results
 */
//MARK: queryCollBasic
async function queryCollectionBasic(collectionId, searchText, topK, threshold = null) {
    const semanticResults = new Map(); // Map of hash -> { semanticScore, text, index }
    console.debug('[Vectors] Performing basic semantic search...with threshold:', threshold, 'and topK:', topK);
    const args = await getAdditionalArgs([searchText]);
    const semanticResponse = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionId: collectionId,
            searchText: searchText,
            topK: topK,
            source: settings.source,
            threshold: threshold !== null ? threshold : settings.score_threshold,
        }),
    });

    const result = await semanticResponse.json();

    for (let i = 0; i < result.hashes.length && i < result.metadata.length; i++) {
        const hash = result.hashes[i];
        const metadata = result.metadata[i];
        const text = metadata?.text || '[No text available]';
        //MARK: scores pulled here
        const semanticScore = Math.max(0, metadata?.score !== undefined ? metadata.score : (SCORING_WEIGHTS.DEFAULT_SEMANTIC_SCORE - (i * SCORING_WEIGHTS.SEMANTIC_DECAY)));

        console.debug(`[Vectors] Semantic result ${i}: hash=${hash}, score=${semanticScore.toFixed(3)}`);

        semanticResults.set(hash, {
            semanticScore: semanticScore,
            text: text,
            index: metadata?.index || i,// Will be set to true if also found in keyword search
        });
    }
    console.debug(`[Vectors] Found ${semanticResults.size} semantic results`);

    if (!semanticResponse.ok) {
        throw new Error(`Failed to query collection ${collectionId}`);
    }

    const hashes = Array.from(semanticResults.keys());
    const metadata = Array.from(semanticResults.values()).map(value => ({
        text: value.text,
        index: value.index,
        score: value.semanticScore,  // Include score for consistency with other functions
    }));

    return { hashes, metadata };
}

/**
 * Intelligent query analysis and keyword extraction for enhanced retrieval
 * @param {string} queryText - The original query text
 * @returns {object} - Analyzed query with keywords, phrases, and scoring weights
 */
function analyzeQuery(queryText) {
    // Check cache first
    if (queryAnalysisCache.has(queryText)) {
        return queryAnalysisCache.get(queryText);
    }

    const analysis = {
        originalQuery: queryText,
        keywords: [],
        keyPhrases: [],
        technicalTerms: [],
        questionType: 'general',
        importanceWeights: {},
    };

    // Normalize query - clean punctuation and normalize
    const normalized = queryText.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

    // Detect question type
    if (normalized.startsWith('what')) analysis.questionType = 'factual';
    else if (normalized.startsWith('how')) analysis.questionType = 'procedural';
    else if (normalized.startsWith('why')) analysis.questionType = 'explanatory';
    else if (normalized.startsWith('when')) analysis.questionType = 'temporal';
    else if (normalized.startsWith('where')) analysis.questionType = 'spatial';

    // Extract technical terms and acronyms (content-agnostic patterns)
    const technicalPatterns = [
        /\b[A-Z]{2,}\b/g, // Acronyms (any 2+ uppercase letters)
    ];

    technicalPatterns.forEach(pattern => {
        const matches = queryText.match(pattern);
        if (matches) {
            analysis.technicalTerms.push(...matches);
            // Technical terms get higher importance
            matches.forEach(term => {
                analysis.importanceWeights[term.toLowerCase()] = 3.0;
            });
        }
    });

    // Extract key phrases (2-4 word combinations) from cleaned text
    const allWords = normalized.split(/\s+/);

    // More sophisticated meaningful word detection
    const meaningfulWords = allWords.filter(word => isMeaningfulWord(word, allWords));

    // Add all meaningful words as keywords first
    const keywordSet = new Set(analysis.keywords);
    meaningfulWords.forEach(word => {
        if (!keywordSet.has(word)) {
            keywordSet.add(word);
            analysis.importanceWeights[word] = analysis.importanceWeights[word] || 1.0;
        }
    });
    analysis.keywords = Array.from(keywordSet);

    // Generate meaningful phrases by looking for consecutive meaningful words
    const meaningfulPhrases = new Set();
    for (let i = 0; i < allWords.length - 1; i++) {
        const currentWord = allWords[i];
        if (isMeaningfulWord(currentWord, allWords, i)) {
            let phrase = [currentWord];

            // Try to extend the phrase with following meaningful words
            for (let j = i + 1; j < allWords.length && j < i + 4; j++) {
                const nextWord = allWords[j];
                if (isMeaningfulWord(nextWord, allWords, j)) {
                    phrase.push(nextWord);
                    // Create phrase if we have 2+ words
                    if (phrase.length >= 2) {
                        const phraseText = phrase.join(' ');
                        if (!meaningfulPhrases.has(phraseText)) {
                            meaningfulPhrases.add(phraseText);
                            analysis.importanceWeights[phraseText] = phrase.length * 1.5;
                        }
                    }
                } else {
                    break; // Stop if we hit a non-meaningful word
                }
            }
        }
    }

    // Generate additional 2-word combinations from all meaningful words (not just consecutive)
    // This helps find combinations like "ridgeline sales" that aren't consecutive in the query
    const additionalPhrases = new Set();
    // Limit to top meaningful words to avoid O(n^2) complexity
    const maxWordsForCombinations = Math.min(meaningfulWords.length, SEARCH_LIMITS.MAX_WORDS_FOR_COMBINATIONS);
    for (let i = 0; i < maxWordsForCombinations - 1; i++) {
        for (let j = i + 1; j < maxWordsForCombinations; j++) {
            const phraseText = `${meaningfulWords[i]} ${meaningfulWords[j]}`;
            if (!meaningfulPhrases.has(phraseText) && !additionalPhrases.has(phraseText)) {
                // Only add if it's a meaningful combination (not just random words)
                if (WordAnalyzer.isMeaningfulCombination(meaningfulWords[i], meaningfulWords[j])) {
                    additionalPhrases.add(phraseText);
                    analysis.importanceWeights[phraseText] = 2.0; // Lower weight than consecutive phrases
                }
            }
        }
    }

    // Add phrases to keyPhrases
    analysis.keyPhrases.push(...Array.from(meaningfulPhrases), ...Array.from(additionalPhrases));

    // Add the full query as a key phrase if it's meaningful and not too long
    if (meaningfulWords.length >= 2 && meaningfulWords.length <= 5 && WordAnalyzer.isMeaningfulPhrase(normalized)) {
        const fullPhrase = meaningfulWords.join(' ');
        if (!analysis.keyPhrases.includes(fullPhrase)) {
            analysis.keyPhrases.push(fullPhrase);
            analysis.importanceWeights[fullPhrase] = 3.0; // Highest weight for full phrase
        }
    }

    // Cache the result
    queryAnalysisCache.set(queryText, analysis);

    return analysis;
}

/**
 * Unified word and phrase analysis for query processing
 * Consolidates multiple analysis functions for better performance
 */
const WordAnalyzer = {
    /**
     * Check if a word is part of query structure (inline optimization)
     * @param {string} word - Word to check
     * @param {string[]} allWords - All words in the query
     * @param {number} position - Position of the word
     * @returns {boolean} - True if this is query structure
     */
    isQueryStructure(word, allWords, position) {
        const lowerWords = allWords.map(w => w?.toLowerCase());
        const firstWord = lowerWords[0];
        const secondWord = lowerWords[1];

        // "Tell me about X", "What/How/Why/When/Where/Who about X", "Can you X", "Please X"
        return (position <= 2 && (firstWord === 'tell' || secondWord === 'tell')) ||
               (position <= 1 && QUESTION_WORDS.includes(firstWord)) ||
               (position <= 1 && firstWord === 'can' && secondWord === 'you') ||
               (position === 0 && firstWord === 'please');
    },

    /**
     * Check if a phrase or word combination is meaningful
     * @param {string|string[]} input - Single phrase string or array of words
     * @returns {boolean} - True if meaningful
     */
    isMeaningfulPhrase(input) {
        const words = Array.isArray(input) ? input : input.split(' ');

        // Avoid phrases that are just stop words
        if (words.every(word => STOP_WORDS.has(word.toLowerCase()))) return false;

        // Prefer phrases with at least one non-stop word
        if (words.some(word => !STOP_WORDS.has(word.toLowerCase()))) {
            // Avoid very common combinations
            const phraseText = words.join(' ');
            return !COMMON_PHRASES.some(common => phraseText.includes(common));
        }

        return false;
    },

    /**
     * Check if two words form a meaningful combination
     * @param {string} word1 - First word
     * @param {string} word2 - Second word
     * @returns {boolean} - True if the combination is likely meaningful
     */
    isMeaningfulCombination(word1, word2) {
        const lowerWord1 = word1.toLowerCase();
        const lowerWord2 = word2.toLowerCase();

        // Skip if either word is a stop word, identical, or too short
        if (STOP_WORDS.has(lowerWord1) || STOP_WORDS.has(lowerWord2) ||
            lowerWord1 === lowerWord2 ||
            (word1.length < 3 && !/\b[A-Z]/.test(word1)) ||
            (word2.length < 3 && !/\b[A-Z]/.test(word2))) {
            return false;
        }

        return true;
    },
};

/**
 * Context-aware check if a word is meaningful for search purposes
 * @param {string} word - Word to check
 * @param {string[]} allWords - All words in the query for context
 * @param {number} [position] - Position of the word in the query (optional)
 * @returns {boolean} - True if the word should be considered meaningful
 */
function isMeaningfulWord(word, allWords, position = -1) {
    // Create cache key that includes word, position, and query context
    const queryHash = allWords.join('|').slice(0, 50);
    const cacheKey = `${word}|${position}|${queryHash}`;

    // Check cache first
    if (wordProcessingCache.has(cacheKey)) {
        return wordProcessingCache.get(cacheKey);
    }

    // Cache size management
    if (wordProcessingCache.size >= WORD_PROCESSING_CACHE_MAX_SIZE) {
        const entries = Array.from(wordProcessingCache.keys());
        for (let i = 0; i < entries.length / 2; i++) {
            wordProcessingCache.delete(entries[i]);
        }
    }

    // Basic length check - early return for optimization
    if (word.length <= 2) {
        wordProcessingCache.set(cacheKey, false);
        return false;
    }

    // Always keep technical terms and acronyms
    if (/\b[A-Z]{2,}\b/.test(word)) {
        wordProcessingCache.set(cacheKey, true);
        return true;
    }

    // Always keep numbers
    if (/\d/.test(word)) {
        wordProcessingCache.set(cacheKey, true);
        return true;
    }

    // Context-aware stop word filtering
    const lowerWord = word.toLowerCase();

    // Check if this word is part of query structure (inlined for performance)
    if (QUERY_STRUCTURE_WORDS.has(lowerWord)) {
        if (WordAnalyzer.isQueryStructure(word, allWords, position)) {
            wordProcessingCache.set(cacheKey, false);
            return false;
        }
        wordProcessingCache.set(cacheKey, true);
        return true;
    }

    // Standard stop word check for other words
    if (STOP_WORDS.has(lowerWord)) {
        // Allow stop words that might be part of titles or proper nouns
        if (word.length >= 5 || position === 0) {
            wordProcessingCache.set(cacheKey, true);
            return true;
        }
        wordProcessingCache.set(cacheKey, false);
        return false;
    }

    wordProcessingCache.set(cacheKey, true);
    return true;
}

/**
 * Calculate relevance score for a chunk based on keyword matches and proximity
 * @param {string} chunkText - The chunk text to score
 * @param {object} queryAnalysis - Analyzed query from analyzeQuery()
 * @returns {object} - Scoring breakdown and total score
 */
function calculateRelevanceScore(chunkText, queryAnalysis) {
    const chunk = chunkText.toLowerCase();
    let totalScore = 0;
    const breakdown = {
        keywordMatches: 0,
        phraseMatches: 0,
        technicalMatches: 0,
        proximityBonus: 0,
        total: 0,
    };

    // Score keyword matches
    queryAnalysis.keywords.forEach(keyword => {
        const count = (chunk.match(new RegExp(keyword, 'gi')) || []).length;
        if (count > 0) {
            const weight = queryAnalysis.importanceWeights[keyword] || 1.0;
            breakdown.keywordMatches += count * weight;
        }
    });

    // Score phrase matches (higher weight for exact phrases)
    queryAnalysis.keyPhrases.forEach(phrase => {
        if (chunk.includes(phrase)) {
            const weight = queryAnalysis.importanceWeights[phrase] || 2.0;
            breakdown.phraseMatches += weight;
        }
    });

    // Score technical term matches (highest weight)
    queryAnalysis.technicalTerms.forEach(term => {
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const count = (chunk.match(regex) || []).length;
        if (count > 0) {
            const weight = queryAnalysis.importanceWeights[term.toLowerCase()] || 3.0;
            breakdown.technicalMatches += count * weight;
        }
    });

    // Calculate proximity bonus (terms close together score higher)
    if (queryAnalysis.keywords.length > 1) {
        const positions = [];
        queryAnalysis.keywords.forEach(keyword => {
            let match;
            const regex = new RegExp(keyword, 'gi');
            while ((match = regex.exec(chunk)) !== null) {
                positions.push(match.index);
            }
        });

        if (positions.length > 1) {
            // Calculate average distance between consecutive terms
            let totalDistance = 0;
            for (let i = 1; i < positions.length; i++) {
                totalDistance += positions[i] - positions[i - 1];
            }
            const avgDistance = totalDistance / (positions.length - 1);

            // Bonus for terms within 100 characters of each other
            if (avgDistance < 100) {
                breakdown.proximityBonus = Math.max(0, (100 - avgDistance) / 100) * SCORING_WEIGHTS.PROXIMITY;
            }
        }
    }

    // Calculate total score with diminishing returns for multiple matches
    totalScore = breakdown.keywordMatches * SCORING_WEIGHTS.KEYWORD +
                 breakdown.phraseMatches * SCORING_WEIGHTS.PHRASE +
                 breakdown.technicalMatches * SCORING_WEIGHTS.TECHNICAL +
                 breakdown.proximityBonus;

    // Apply diminishing returns (logarithmic scaling)
    if (totalScore > 5) {
        totalScore = 5 + Math.log(totalScore - 4);
    }

    breakdown.total = totalScore;
    return breakdown;
}

/**
 * Intelligent hybrid search for technical queries with relevance scoring
 * @param {string} collectionId - Collection ID to query
 * @param {string} searchText - Original search text
 * @param {object} queryAnalysis - Analyzed query structure
 * @param {number} topK - Number of results to return
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Ranked results
 */
/**
 * Formats keywords for display, prioritizing phrases over individual keywords
 * @param {string[]} foundKeywords - Array of keywords found in the search
 * @returns {string} - Formatted keyword string with phrases first
 */
function formatKeywordsForDisplay(foundKeywords) {
    if (!foundKeywords || foundKeywords.length === 0) return '';

    // Separate phrases from individual keywords
    const phrases = foundKeywords.filter(k => k.includes(' '));
    const individualKeywords = foundKeywords.filter(k => !k.includes(' '));

    // Combine with phrases first, then individual keywords
    const allKeywords = [...phrases, ...individualKeywords];
    return allKeywords.join(', ');
}

async function intelligentHybridSearch(collectionId, searchText, queryAnalysis, topK, threshold = settings.score_threshold, allowChunkMerging = false) {
    const semanticResults = new Map(); // hash -> semantic data
    const keywordResults = new Map(); // hash -> keyword data
    const intersectionBonus = SCORING_WEIGHTS.INTERSECTION_BONUS; // Bonus for chunks that appear in both semantic and keyword results

    // 1. SEMANTIC SEARCH: Get semantic results with API scores
    try {
        const semanticSearchCount = Math.max(settings.chunk_count_db * SEARCH_LIMITS.SEMANTIC_SEARCH_MULTIPLIER, 20);
        const semanticResponse = await queryCollectionBasic(collectionId, searchText, semanticSearchCount, settings.score_threshold);

        for (let i = 0; i < semanticResponse.hashes.length && i < semanticResponse.metadata.length; i++) {
            const hash = semanticResponse.hashes[i];
            const metadata = semanticResponse.metadata[i];
            const text = metadata?.text || '[No text available]';
            //MARK: scores pulled here
            const semanticScore = Math.max(0, metadata?.score !== undefined ? metadata.score : (SCORING_WEIGHTS.DEFAULT_SEMANTIC_SCORE - (i * SCORING_WEIGHTS.SEMANTIC_DECAY)));

            console.debug(`[Vectors] Semantic result ${i}: hash=${hash}, score=${semanticScore.toFixed(3)}`);

            semanticResults.set(hash, {
                semanticScore: semanticScore,
                text: text,
                index: metadata?.index || i,
                inIntersection: false, // Will be set to true if also found in keyword search
            });
        }
        console.debug(`[Vectors] Found ${semanticResults.size} semantic results`);
    } catch (error) {
        console.warn('Semantic search failed:', error);
    }

    // 2. KEYWORD SEARCH: Search all chunks for keyword matches
    const maxChunksToSearch = Math.max(settings.chunk_count_db * 3, SEARCH_LIMITS.MAX_CHUNKS_TO_SEARCH);

    // Prepare search terms with improved strategy
    // Prioritize: longer phrases > technical terms > individual keywords
    let searchTerms = [
        // All key phrases (both consecutive and non-consecutive)
        ...queryAnalysis.keyPhrases.sort((a, b) => b.length - a.length),
        // Technical terms
        ...queryAnalysis.technicalTerms,
        // Individual keywords (always included as fallback)
        ...queryAnalysis.keywords,
    ].filter((term, index, arr) => arr.indexOf(term) === index);

    // Limit search terms to avoid excessive processing
    const maxSearchTerms = SEARCH_LIMITS.MAX_SEARCH_TERMS;
    if (searchTerms.length > maxSearchTerms) {
        searchTerms = searchTerms.slice(0, maxSearchTerms);
        console.debug(`[Vectors] Limited search terms to ${maxSearchTerms} (was ${searchTerms.length})`);
    }

    console.debug(`[Vectors] Searching for ${searchTerms.length} terms: ${searchTerms.join(', ')}`);
    console.debug(`[Vectors] Key phrases: ${queryAnalysis.keyPhrases.length}, Technical terms: ${queryAnalysis.technicalTerms.length}, Keywords: ${queryAnalysis.keywords.length}`);

    // Track covered keywords to avoid redundant searches
    const coveredKeywords = new Set();

    for (const term of searchTerms) {
        // Skip individual keywords if they're already covered by successful phrase searches
        if (!term.includes(' ') && coveredKeywords.has(term.toLowerCase())) {
            console.debug(`[Vectors] Skipping keyword "${term}" - already covered by phrase search`);
            continue;
        }

        try {
            console.debug(`[Vectors] Searching for: "${term}"`);
            const isPhrase = term.includes(' ');
            const isTechnicalTerm = queryAnalysis.technicalTerms.includes(term);

            let termResults;
            if (isTechnicalTerm && !isPhrase) {
                termResults = await exactKeywordSearch(collectionId, term, maxChunksToSearch, searchText);
            } else if (isPhrase) {
                termResults = await exactKeywordSearch(collectionId, term, maxChunksToSearch, searchText);
            } else {
                termResults = await queryCollectionBasic(collectionId, term, maxChunksToSearch, settings.score_threshold);
            }

            console.debug(`[Vectors] Found ${termResults.hashes.length} results for "${term}"`);

            // Mark phrase words as covered
            if (isPhrase && termResults.hashes.length > 0) {
                const phraseWords = term.toLowerCase().split(' ').filter(word => word.length > 2);
                phraseWords.forEach(word => coveredKeywords.add(word));
                console.debug(`[Vectors] Phrase "${term}" successful - covering: ${phraseWords.join(', ')}`);
            }

            // Process keyword results
            for (let i = 0; i < termResults.hashes.length && i < termResults.metadata.length; i++) {
                const hash = termResults.hashes[i];
                const metadata = termResults.metadata[i];
                const text = metadata?.text || '';

                // For semantic keyword searches, verify the term is actually in the text
                if (!isTechnicalTerm && !isPhrase && !text.toLowerCase().includes(term.toLowerCase())) {
                    continue;
                }

                const weight = queryAnalysis.importanceWeights[term.toLowerCase()] || 1.0;
                // Use consistent scoring regardless of position - base score per term type
                const baseScore = isPhrase ? 3.0 : (isTechnicalTerm ? 2.0 : 1.0);
                const termScore = baseScore * weight;

                if (keywordResults.has(hash)) {
                    // Check if this term is already counted for this chunk
                    const existing = keywordResults.get(hash);
                    if (!existing.foundKeywords.includes(term)) {
                        // Check if this chunk was found via a phrase that contains this term
                        const hasPhraseWithTerm = existing.foundKeywords.some(kw => kw.includes(' ') && kw.includes(term));
                        if (!hasPhraseWithTerm) {
                            existing.keywordScore += termScore;
                            existing.foundKeywords.push(term);
                            console.debug(`[Vectors] Updated keyword result ${hash}: +${termScore.toFixed(3)} for "${term}"`);
                        } else {
                            console.debug(`[Vectors] Skipping individual keyword "${term}" for chunk ${hash} - already covered by phrase`);
                        }
                    } else {
                        console.debug(`[Vectors] Skipping duplicate term "${term}" for chunk ${hash}`);
                    }
                } else {
                    keywordResults.set(hash, {
                        keywordScore: termScore,
                        foundKeywords: [term],
                        text: text,
                        index: metadata?.index || i,
                        inIntersection: false,
                    });
                    console.debug(`[Vectors] New keyword result ${hash}: ${termScore.toFixed(3)} for "${term}"`);
                }
            }
        } catch (error) {
            console.warn(`Keyword search failed for "${term}":`, error);
        }
    }

    console.debug(`[Vectors] Found ${keywordResults.size} keyword results`);

    // 3. FIND INTERSECTION: Mark chunks that appear in both semantic and keyword results
    let intersectionCount = 0;

    for (const [hash, semanticData] of semanticResults) {
        if (keywordResults.has(hash)) {
            semanticData.inIntersection = true;
            keywordResults.get(hash).inIntersection = true;
            intersectionCount++;
            console.debug(`[Vectors] Intersection found: ${hash} (+${intersectionBonus} bonus)`);
        }
    }

    console.debug(`[Vectors] Found ${intersectionCount} chunks in both semantic and keyword results`);

    // 4. COMBINE AND NORMALIZE SCORES
    const allResults = new Map();

    // Add semantic results
    for (const [hash, data] of semanticResults) {
        const intersectionBonusValue = data.inIntersection ? intersectionBonus : 0;
        const normalizedKeywordScore = 0.5; // Default for semantic-only results

        allResults.set(hash, {
            hash,
            semanticScore: data.semanticScore,
            keywordScore: 0, // Semantic results don't have keyword scores
            normalizedKeywordScore: normalizedKeywordScore,
            intersectionBonus: intersectionBonusValue,
            finalScore: (data.semanticScore * 0.2) + (normalizedKeywordScore * 0.7) + intersectionBonusValue,
            text: data.text,
            index: data.index,
            source: 'semantic',
            foundKeywords: [], // No keywords found for semantic-only results
        });
    }

    // Add keyword results (skip if already added from semantic)
    for (const [hash, data] of keywordResults) {
        if (allResults.has(hash)) {
            // Update existing semantic result with keyword data
            const existing = allResults.get(hash);
            const normalizedKeywordScore = 1 / (1 + Math.exp(-data.keywordScore * SCORING_WEIGHTS.NORMALIZATION_SCALE));
            const intersectionBonusValue = data.inIntersection ? intersectionBonus : 0;

            existing.keywordScore = data.keywordScore;
            existing.normalizedKeywordScore = normalizedKeywordScore;
            existing.intersectionBonus = intersectionBonusValue;
            existing.finalScore = (existing.semanticScore * 0.2) + (normalizedKeywordScore * 0.7) + intersectionBonusValue;
            existing.source = 'both';
            existing.foundKeywords = data.foundKeywords;
        } else {
            // New keyword-only result
            const normalizedKeywordScore = 1 / (1 + Math.exp(-data.keywordScore * SCORING_WEIGHTS.NORMALIZATION_SCALE));
            const intersectionBonusValue = data.inIntersection ? intersectionBonus : 0;

            allResults.set(hash, {
                hash,
                semanticScore: 0, // Keyword-only results don't have semantic scores
                keywordScore: data.keywordScore,
                normalizedKeywordScore: normalizedKeywordScore,
                intersectionBonus: intersectionBonusValue,
                finalScore: (0 * 0.2) + (normalizedKeywordScore * 0.7) + intersectionBonusValue,
                text: data.text,
                index: data.index,
                source: 'keyword',
                foundKeywords: data.foundKeywords,
            });
        }
    }

    // 5. SORT AND RETURN TOP RESULTS
    const scoredResults = Array.from(allResults.values())
        .filter(result => result.finalScore >= threshold)
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, settings.chunk_count_db);

    console.log(`[Vectors] Final Results (${scoredResults.length} items):`);
    scoredResults.forEach((result, index) => {
        const keywordsDisplay = result.foundKeywords && result.foundKeywords.length > 0
            ? ` [${formatKeywordsForDisplay(result.foundKeywords)}]`
            : '';
        console.log(`[Vectors]   ${index + 1}. Score: ${result.finalScore.toFixed(3)} (${result.source})${keywordsDisplay}`);
        console.log(`[Vectors]      Semantic: ${result.semanticScore.toFixed(3)}, Keyword: ${result.keywordScore.toFixed(3)}, Normalized: ${result.normalizedKeywordScore.toFixed(3)}, Intersection: ${result.intersectionBonus.toFixed(3)}`);
        console.log(`[Vectors]      Text: "${result.text.substring(0, 80)}..."`);
    });

    return {
        hashes: scoredResults.map(r => r.hash),
        metadata: scoredResults.map(r => ({
            text: r.text,
            index: r.index,
            score: r.finalScore,
            semanticScore: r.semanticScore,
            keywordScore: r.keywordScore,
            normalizedKeywordScore: r.normalizedKeywordScore,
            intersectionBonus: r.intersectionBonus,
        })),
    };
}

// Make functions available globally for testing
window['analyzeQuery'] = analyzeQuery;
window['calculateRelevanceScore'] = calculateRelevanceScore;
window['smartQueryCollection'] = smartQueryCollection;


/**
 * Gets the text to query from the chat
 * @param {object[]} chat Chat messages
 * @param {'file'|'chat'|'world-info'} initiator Initiator of the query
 * @returns {Promise<string>} Text to query
 */
async function getQueryText(chat, initiator) {
    let hashedMessages = chat
        .map(x => ({ text: String(substituteParams(x.mes)), hash: getStringHash(substituteParams(x.mes)), index: chat.indexOf(x) }))
        .filter(x => x.text)
        .reverse()
        .slice(0, settings.query);

    if (initiator === 'chat' && settings.enabled_chats && settings.summarize && settings.summarize_sent) {
        hashedMessages = await summarize(hashedMessages, settings.summary_source);
    }

    const queryText = hashedMessages.map(x => x.text).join('\n');
    console.debug('Vectors: Generated query text from', hashedMessages.length, 'messages');

    return collapseNewlines(queryText).trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @returns {object} Request body
 */
function getVectorsRequestBody(args = {}) {
    const body = Object.assign({}, args);
    switch (settings.source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'togetherai':
            body.model = extension_settings.vectors.togetherai_model;
            break;
        case 'openai':
            body.model = extension_settings.vectors.openai_model;
            break;
        case 'cohere':
            body.model = extension_settings.vectors.cohere_model;
            break;
        case 'ollama':
            body.model = extension_settings.vectors.ollama_model;
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!extension_settings.vectors.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            break;
        case 'vllm':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            body.model = extension_settings.vectors.vllm_model;
            break;
        case 'webllm':
            body.model = extension_settings.vectors.webllm_model;
            break;
        case 'palm':
            body.model = extension_settings.vectors.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = extension_settings.vectors.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for vector requests.
 * @param {string[]} items Items to embed
 * @returns {Promise<object>} Additional arguments
 */
async function getAdditionalArgs(items) {
    const args = {};
    switch (settings.source) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
    }
    return args;
}

/**
 * Gets the saved hashes for a collection
* @param {string} collectionId
* @returns {Promise<number[]>} Saved hashes
*/
async function getSavedHashes(collectionId) {
    const args = await getAdditionalArgs([]);
    const response = await fetch('/api/vector/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionId: collectionId,
            source: settings.source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to get saved hashes for collection ${collectionId}`);
    }

    const hashes = await response.json();
    return hashes;
}

/**
 * Inserts vector items into a collection
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @returns {Promise<void>}
 */
async function insertVectorItems(collectionId, items) {
    throwIfSourceInvalid();

    const args = await getAdditionalArgs(items.map(x => x.text));
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionId: collectionId,
            items: items,
            source: settings.source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to insert vector items for collection ${collectionId}`);
    }
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 */
function throwIfSourceInvalid() {
    if (settings.source === 'openai' && !secret_state[SECRET_KEYS.OPENAI] ||
        settings.source === 'palm' && !secret_state[SECRET_KEYS.MAKERSUITE] ||
        settings.source === 'vertexai' && !secret_state[SECRET_KEYS.VERTEXAI] && !secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT] ||
        settings.source === 'mistral' && !secret_state[SECRET_KEYS.MISTRALAI] ||
        settings.source === 'togetherai' && !secret_state[SECRET_KEYS.TOGETHERAI] ||
        settings.source === 'nomicai' && !secret_state[SECRET_KEYS.NOMICAI] ||
        settings.source === 'cohere' && !secret_state[SECRET_KEYS.COHERE]) {
        throw new Error('Vectors: API key missing', { cause: 'api_key_missing' });
    }

    if (vectorApiRequiresUrl.includes(settings.source) && settings.use_alt_endpoint) {
        if (!settings.alt_endpoint_url) {
            throw new Error('Vectors: API URL missing', { cause: 'api_url_missing' });
        }
    }
    else {
        if (settings.source === 'ollama' && !textgenerationwebui_settings.server_urls[textgen_types.OLLAMA] ||
            settings.source === 'vllm' && !textgenerationwebui_settings.server_urls[textgen_types.VLLM] ||
            settings.source === 'koboldcpp' && !textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP] ||
            settings.source === 'llamacpp' && !textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]) {
            throw new Error('Vectors: API URL missing', { cause: 'api_url_missing' });
        }
    }

    if (settings.source === 'ollama' && !settings.ollama_model || settings.source === 'vllm' && !settings.vllm_model) {
        throw new Error('Vectors: API model missing', { cause: 'api_model_missing' });
    }

    if (settings.source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('Vectors: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    if (settings.source === 'webllm' && (!isWebLlmSupported() || !settings.webllm_model)) {
        throw new Error('Vectors: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @returns {Promise<void>}
 */
async function deleteVectorItems(collectionId, hashes) {
    const response = await fetch('/api/vector/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            hashes: hashes,
            source: settings.source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to delete vector items for collection ${collectionId}`);
    }
}

/**
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes of the results
 */
//MARK: queryCollection
async function queryCollection(collectionId, searchText, topK, threshold = null) {
    // Use intelligent search instead of basic API call
    return await smartQueryCollection(collectionId, searchText, topK, threshold);
}

/**
 * Queries multiple collections for a given text.
 * @param {string[]} collectionIds - Collection IDs to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
async function queryMultipleCollections(collectionIds, searchText, topK, threshold) {
    const args = await getAdditionalArgs([searchText]);
    const response = await fetch('/api/vector/query-multi', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionIds: collectionIds,
            searchText: searchText,
            topK: topK,
            source: settings.source,
            threshold: threshold ?? settings.score_threshold,
        }),
    });

    if (!response.ok) {
        throw new Error('Failed to query multiple collections');
    }

    return await response.json();
}

/**
 * Purges the vector index for a file.
 * @param {string} fileUrl File URL to purge
 */
async function purgeFileVectorIndex(fileUrl) {
    try {
        if (!settings.enabled_files) {
            return;
        }

        console.debug(`[Vectors] Purging file vector index for ${fileUrl}`);
        const collectionId = getFileCollectionId(fileUrl);

        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...getVectorsRequestBody(),
                collectionId: collectionId,
            }),
        });

        if (!response.ok) {
            throw new Error(`Could not delete vector index for collection ${collectionId}`);
        }

        console.debug(`[Vectors] Purged vector index for collection ${collectionId}`);
    } catch (error) {
        console.error('Vectors: Failed to purge file', error);
    }
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @returns <Promise<boolean>> True if deleted, false if not
 */
async function purgeVectorIndex(collectionId) {
    try {
        if (!settings.enabled_chats) {
            return true;
        }

        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...getVectorsRequestBody(),
                collectionId: collectionId,
            }),
        });

        if (!response.ok) {
            throw new Error(`Could not delete vector index for collection ${collectionId}`);
        }

        console.debug(`[Vectors] Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        console.error('Vectors: Failed to purge', error);
        return false;
    }
}

/**
 * Purges all vector indexes.
 */
async function purgeAllVectorIndexes() {
    try {
        const response = await fetch('/api/vector/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...getVectorsRequestBody(),
            }),
        });

        if (!response.ok) {
            throw new Error('Failed to purge all vector indexes');
        }

        console.debug('[Vectors] Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        console.error('Vectors: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

function toggleSettings() {
    $('#vectors_files_settings').toggle(!!settings.enabled_files);
    $('#vectors_chats_settings').toggle(!!settings.enabled_chats);
    $('#vectors_world_info_settings').toggle(!!settings.enabled_world_info);
    $('#together_vectorsModel').toggle(settings.source === 'togetherai');
    $('#openai_vectorsModel').toggle(settings.source === 'openai');
    $('#cohere_vectorsModel').toggle(settings.source === 'cohere');
    $('#ollama_vectorsModel').toggle(settings.source === 'ollama');
    $('#llamacpp_vectorsModel').toggle(settings.source === 'llamacpp');
    $('#vllm_vectorsModel').toggle(settings.source === 'vllm');
    $('#nomicai_apiKey').toggle(settings.source === 'nomicai');
    $('#webllm_vectorsModel').toggle(settings.source === 'webllm');
    $('#koboldcpp_vectorsModel').toggle(settings.source === 'koboldcpp');
    $('#google_vectorsModel').toggle(settings.source === 'palm' || settings.source === 'vertexai');
    $('#vector_altEndpointUrl').toggle(vectorApiRequiresUrl.includes(settings.source));
    if (settings.source === 'webllm') {
        loadWebLlmModels();
    }
}

/**
 * Executes a function with WebLLM error handling.
 * @param {function(): Promise<T>} func Function to execute
 * @returns {Promise<T>}
 * @template T
 */
async function executeWithWebLlmErrorHandling(func) {
    try {
        return await func();
    } catch (error) {
        console.log('[Vectors] Failed to load WebLLM models', error);
        if (!(error instanceof Error)) {
            return;
        }
        switch (error.cause) {
            case 'webllm-not-available':
                toastr.warning('WebLLM is not available. Please install the extension.', 'WebLLM not installed');
                break;
            case 'webllm-not-updated':
                toastr.warning('The installed extension version does not support embeddings.', 'WebLLM update required');
                break;
        }
    }
}

/**
 * Loads and displays WebLLM models in the settings.
 * @returns {Promise<void>}
 */
function loadWebLlmModels() {
    return executeWithWebLlmErrorHandling(() => {
        const models = webllmProvider.getModels();
        $('#vectors_webllm_model').empty();
        for (const model of models) {
            $('#vectors_webllm_model').append($('<option>', { value: model.id, text: model.toString() }));
        }
        if (!settings.webllm_model || !models.some(x => x.id === settings.webllm_model)) {
            if (models.length) {
                settings.webllm_model = models[0].id;
            }
        }
        $('#vectors_webllm_model').val(settings.webllm_model);
        return Promise.resolve();
    });
}

/**
 * Creates WebLLM embeddings for a list of items.
 * @param {string[]} items Items to embed
 * @returns {Promise<Record<string, number[]>>} Calculated embeddings
 */
async function createWebLlmEmbeddings(items) {
    if (items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }
    return executeWithWebLlmErrorHandling(async () => {
        const embeddings = await webllmProvider.embedTexts(items, settings.webllm_model);
        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            result[items[i]] = embeddings[i];
        }
        return result;
    });
}

/**
 * Creates KoboldCpp embeddings for a list of items.
 * @param {string[]} items Items to embed
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>} Calculated embeddings
 */
async function createKoboldCppEmbeddings(items) {
    const response = await fetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            items: items,
            server: settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP],
        }),
    });

    if (!response.ok) {
        throw new Error('Failed to get KoboldCpp embeddings');
    }

    const data = await response.json();
    if (!Array.isArray(data.embeddings) || !data.model || data.embeddings.length !== items.length) {
        throw new Error('Invalid response from KoboldCpp embeddings');
    }

    const embeddings = /** @type {Record<string, number[]>} */ ({});
    for (let i = 0; i < data.embeddings.length; i++) {
        if (!Array.isArray(data.embeddings[i]) || data.embeddings[i].length === 0) {
            throw new Error('KoboldCpp returned an empty embedding. Reduce the chunk size and/or size threshold and try again.');
        }

        embeddings[items[i]] = data.embeddings[i];
    }

    return {
        embeddings: embeddings,
        model: data.model,
    };
}

async function onPurgeClick() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.info('No chat selected', 'Purge aborted');
        return;
    }
    if (await purgeVectorIndex(chatId)) {
        toastr.success('Vector index purged', 'Purge successful');
    } else {
        toastr.error('Failed to purge vector index', 'Purge failed');
    }
}

async function onViewStatsClick() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.info('No chat selected');
        return;
    }

    const hashesInCollection = await getSavedHashes(chatId);
    const totalHashes = hashesInCollection.length;
    const uniqueHashes = hashesInCollection.filter(onlyUnique).length;

    toastr.info(`Total hashes: <b>${totalHashes}</b><br>
    Unique hashes: <b>${uniqueHashes}</b><br><br>
    I'll mark collected messages with a green circle.`,
    `Stats for chat ${escapeHtml(chatId)}`,
    { timeOut: 10000, escapeHtml: false },
    );

    const chat = getContext().chat;
    for (const message of chat) {
        if (hashesInCollection.includes(getStringHash(substituteParams(message.mes)))) {
            const messageElement = $(`.mes[mesid="${chat.indexOf(message)}"]`);
            messageElement.addClass('vectorized');
        }
    }

}

async function onVectorizeAllFilesClick() {
    try {
        const dataBank = getDataBankAttachments();
        const chatAttachments = getContext().chat.filter(x => x.extra?.file).map(x => x.extra.file);
        const allFiles = [...dataBank, ...chatAttachments];

        /**
         * Gets the chunk size for a file attachment.
         * @param file {import('../../chats.js').FileAttachment} File attachment
         * @returns {number} Chunk size for the file
         */
        function getChunkSize(file) {
            if (chatAttachments.includes(file)) {
                // Convert kilobytes to string length
                const thresholdLength = settings.size_threshold * 1024;
                return file.size > thresholdLength ? settings.chunk_size : -1;
            }

            if (dataBank.includes(file)) {
                // Convert kilobytes to string length
                const thresholdLength = settings.size_threshold_db * 1024;
                // Use chunk size from settings if file is larger than threshold
                return file.size > thresholdLength ? settings.chunk_size_db : -1;
            }

            return -1;
        }

        /**
         * Gets the overlap percent for a file attachment.
         * @param file {import('../../chats.js').FileAttachment} File attachment
         * @returns {number} Overlap percent for the file
         */
        function getOverlapPercent(file) {
            if (chatAttachments.includes(file)) {
                return settings.overlap_percent;
            }

            if (dataBank.includes(file)) {
                return settings.overlap_percent_db;
            }

            return 0;
        }

        let allSuccess = true;

        for (const file of allFiles) {
            const text = await getFileAttachment(file.url);
            const collectionId = getFileCollectionId(file.url);
            const hashes = await getSavedHashes(collectionId);

            if (hashes.length) {
                console.log(`Vectors: File ${file.name} is already vectorized`);
                continue;
            }

            const chunkSize = getChunkSize(file);
            const overlapPercent = getOverlapPercent(file);
            const result = await vectorizeFile(text, file.name, collectionId, chunkSize, overlapPercent);

            if (!result) {
                allSuccess = false;
            }
        }

        if (allSuccess) {
            toastr.success('All files vectorized', 'Vectorization successful');
        } else {
            toastr.warning('Some files failed to vectorize. Check browser console for more details.', 'Vector Storage');
        }
    } catch (error) {
        console.error('Vectors: Failed to vectorize all files', error);
        toastr.error('Failed to vectorize all files', 'Vectorization failed');
    }
}

async function onPurgeFilesClick() {
    try {
        const dataBank = getDataBankAttachments();
        const chatAttachments = getContext().chat.filter(x => x.extra?.file).map(x => x.extra.file);
        const allFiles = [...dataBank, ...chatAttachments];

        for (const file of allFiles) {
            await purgeFileVectorIndex(file.url);
        }

        toastr.success('All files purged', 'Purge successful');
    } catch (error) {
        console.error('Vectors: Failed to purge all files', error);
        toastr.error('Failed to purge all files', 'Purge failed');
    }
}

async function activateWorldInfo(chat) {
    if (!settings.enabled_world_info) {
        console.debug('Vectors: Disabled for World Info');
        return;
    }

    const entries = await getSortedEntries();

    if (!Array.isArray(entries) || entries.length === 0) {
        console.debug('Vectors: No WI entries found');
        return;
    }

    // Group entries by "world" field
    const groupedEntries = {};

    for (const entry of entries) {
        // Skip orphaned entries. Is it even possible?
        if (!entry.world) {
            console.debug('Vectors: Skipped orphaned WI entry', entry);
            continue;
        }

        // Skip disabled entries
        if (entry.disable) {
            console.debug('Vectors: Skipped disabled WI entry', entry);
            continue;
        }

        // Skip entries without content
        if (!entry.content) {
            console.debug('Vectors: Skipped WI entry without content', entry);
            continue;
        }

        // Skip non-vectorized entries
        if (!entry.vectorized && !settings.enabled_for_all) {
            console.debug('Vectors: Skipped non-vectorized WI entry', entry);
            continue;
        }

        if (!Object.hasOwn(groupedEntries, entry.world)) {
            groupedEntries[entry.world] = [];
        }

        groupedEntries[entry.world].push(entry);
    }

    const collectionIds = [];

    if (Object.keys(groupedEntries).length === 0) {
        console.debug('Vectors: No WI entries to synchronize');
        return;
    }

    // Synchronize collections
    for (const world in groupedEntries) {
        const collectionId = `world_${getStringHash(world)}`;
        const hashesInCollection = await getSavedHashes(collectionId);
        const newEntries = groupedEntries[world].filter(x => !hashesInCollection.includes(getStringHash(x.content)));
        const deletedHashes = hashesInCollection.filter(x => !groupedEntries[world].some(y => getStringHash(y.content) === x));

        if (newEntries.length > 0) {
            console.log(`Vectors: Found ${newEntries.length} new WI entries for world ${world}`);
            await insertVectorItems(collectionId, newEntries.map(x => ({ hash: getStringHash(x.content), text: x.content, index: x.uid })));
        }

        if (deletedHashes.length > 0) {
            console.log(`Vectors: Deleted ${deletedHashes.length} old hashes for world ${world}`);
            await deleteVectorItems(collectionId, deletedHashes);
        }

        collectionIds.push(collectionId);
    }

    // Perform a multi-query
    const queryText = await getQueryText(chat, 'world-info');

    if (queryText.length === 0) {
        console.debug('Vectors: No text to query for WI');
        return;
    }

    const queryResults = await queryMultipleCollections(collectionIds, queryText, settings.max_entries, settings.score_threshold);
    const activatedHashes = Object.values(queryResults).flatMap(x => x.hashes).filter(onlyUnique);
    const activatedEntries = [];

    // Activate entries found in the query results
    for (const entry of entries) {
        const hash = getStringHash(entry.content);

        if (activatedHashes.includes(hash)) {
            activatedEntries.push(entry);
        }
    }

    if (activatedEntries.length === 0) {
        console.debug('Vectors: No activated WI entries found');
        return;
    }

    console.log(`Vectors: Activated ${activatedEntries.length} WI entries`, activatedEntries);
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activatedEntries);
}

jQuery(async () => {
    if (!extension_settings.vectors) {
        extension_settings.vectors = settings;
    }

    // Migrate from old settings
    if (settings['enabled']) {
        settings.enabled_chats = true;
    }

    Object.assign(settings, extension_settings.vectors);

    // Migrate from TensorFlow to Transformers
    settings.source = settings.source !== 'local' ? settings.source : 'transformers';
    const template = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#vectors_container').append(template);
    $('#vectors_enabled_chats').prop('checked', settings.enabled_chats).on('input', () => {
        settings.enabled_chats = $('#vectors_enabled_chats').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vectors_augment_keyword_search').prop('checked', settings.augment_keyword_search).on('input', () => {
        settings.augment_keyword_search = $('#vectors_augment_keyword_search').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_enabled_files').prop('checked', settings.enabled_files).on('input', () => {
        settings.enabled_files = $('#vectors_enabled_files').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vectors_source').val(settings.source).on('change', () => {
        settings.source = String($('#vectors_source').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vector_altEndpointUrl_enabled').prop('checked', settings.use_alt_endpoint).on('input', () => {
        settings.use_alt_endpoint = $('#vector_altEndpointUrl_enabled').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vector_altEndpoint_address').val(settings.alt_endpoint_url).on('change', () => {
        settings.alt_endpoint_url = String($('#vector_altEndpoint_address').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_togetherai_model').val(settings.togetherai_model).on('change', () => {
        settings.togetherai_model = String($('#vectors_togetherai_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_openai_model').val(settings.openai_model).on('change', () => {
        settings.openai_model = String($('#vectors_openai_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_cohere_model').val(settings.cohere_model).on('change', () => {
        settings.cohere_model = String($('#vectors_cohere_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_ollama_model').val(settings.ollama_model).on('input', () => {
        settings.ollama_model = String($('#vectors_ollama_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_vllm_model').val(settings.vllm_model).on('input', () => {
        settings.vllm_model = String($('#vectors_vllm_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_ollama_keep').prop('checked', settings.ollama_keep).on('input', () => {
        settings.ollama_keep = $('#vectors_ollama_keep').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_template').val(settings.template).on('input', () => {
        settings.template = String($('#vectors_template').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_depth').val(settings.depth).on('input', () => {
        settings.depth = Number($('#vectors_depth').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_protect').val(settings.protect).on('input', () => {
        settings.protect = Number($('#vectors_protect').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_insert').val(settings.insert).on('input', () => {
        settings.insert = Number($('#vectors_insert').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_query').val(settings.query).on('input', () => {
        settings.query = Number($('#vectors_query').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $(`input[name="vectors_position"][value="${settings.position}"]`).prop('checked', true);
    $('input[name="vectors_position"]').on('change', () => {
        settings.position = Number($('input[name="vectors_position"]:checked').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_vectorize_all').on('click', onVectorizeAllClick);
    $('#vectors_purge').on('click', onPurgeClick);
    $('#vectors_view_stats').on('click', onViewStatsClick);
    $('#vectors_files_vectorize_all').on('click', onVectorizeAllFilesClick);
    $('#vectors_files_purge').on('click', onPurgeFilesClick);

    $('#vectors_size_threshold').val(settings.size_threshold).on('input', () => {
        settings.size_threshold = Number($('#vectors_size_threshold').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_size').val(settings.chunk_size).on('input', () => {
        settings.chunk_size = Number($('#vectors_chunk_size').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_count').val(settings.chunk_count).on('input', () => {
        settings.chunk_count = Number($('#vectors_chunk_count').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_include_wi').prop('checked', settings.include_wi).on('input', () => {
        settings.include_wi = !!$('#vectors_include_wi').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summarize').prop('checked', settings.summarize).on('input', () => {
        settings.summarize = !!$('#vectors_summarize').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summarize_user').prop('checked', settings.summarize_sent).on('input', () => {
        settings.summarize_sent = !!$('#vectors_summarize_user').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_source').val(settings.summary_source).on('change', () => {
        settings.summary_source = String($('#vectors_summary_source').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_prompt').val(settings.summary_prompt).on('input', () => {
        settings.summary_prompt = String($('#vectors_summary_prompt').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_message_chunk_size').val(settings.message_chunk_size).on('input', () => {
        settings.message_chunk_size = Number($('#vectors_message_chunk_size').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_size_threshold_db').val(settings.size_threshold_db).on('input', () => {
        settings.size_threshold_db = Number($('#vectors_size_threshold_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_size_db').val(settings.chunk_size_db).on('input', () => {
        settings.chunk_size_db = Number($('#vectors_chunk_size_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_count_db').val(settings.chunk_count_db).on('input', () => {
        settings.chunk_count_db = Number($('#vectors_chunk_count_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_overlap_percent').val(settings.overlap_percent).on('input', () => {
        settings.overlap_percent = Number($('#vectors_overlap_percent').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_overlap_percent_db').val(settings.overlap_percent_db).on('input', () => {
        settings.overlap_percent_db = Number($('#vectors_overlap_percent_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_template_db').val(settings.file_template_db).on('input', () => {
        settings.file_template_db = String($('#vectors_file_template_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $(`input[name="vectors_file_position_db"][value="${settings.file_position_db}"]`).prop('checked', true);
    $('input[name="vectors_file_position_db"]').on('change', () => {
        settings.file_position_db = Number($('input[name="vectors_file_position_db"]:checked').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_depth_db').val(settings.file_depth_db).on('input', () => {
        settings.file_depth_db = Number($('#vectors_file_depth_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_depth_role_db').val(settings.file_depth_role_db).on('input', () => {
        settings.file_depth_role_db = Number($('#vectors_file_depth_role_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_translate_files').prop('checked', settings.translate_files).on('input', () => {
        settings.translate_files = !!$('#vectors_translate_files').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_enabled_world_info').prop('checked', settings.enabled_world_info).on('input', () => {
        settings.enabled_world_info = !!$('#vectors_enabled_world_info').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });

    $('#vectors_enabled_for_all').prop('checked', settings.enabled_for_all).on('input', () => {
        settings.enabled_for_all = !!$('#vectors_enabled_for_all').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_max_entries').val(settings.max_entries).on('input', () => {
        settings.max_entries = Number($('#vectors_max_entries').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_score_threshold').val(settings.score_threshold).on('input', () => {
        settings.score_threshold = Number($('#vectors_score_threshold').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_force_chunk_delimiter').val(settings.force_chunk_delimiter).on('input', () => {
        settings.force_chunk_delimiter = String($('#vectors_force_chunk_delimiter').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_only_custom_boundary').prop('checked', settings.only_custom_boundary).on('input', () => {
        settings.only_custom_boundary = !!$('#vectors_only_custom_boundary').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_ollama_pull').on('click', (e) => {
        const presetModel = extension_settings.vectors.ollama_model || '';
        e.preventDefault();
        $('#ollama_download_model').trigger('click');
        $('#dialogue_popup_input').val(presetModel);
    });

    $('#vectors_webllm_install').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM is already installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    $('#vectors_webllm_model').on('input', () => {
        settings.webllm_model = String($('#vectors_webllm_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_webllm_load').on('click', async () => {
        if (!settings.webllm_model) return;
        await webllmProvider.loadModel(settings.webllm_model);
        toastr.success('WebLLM model loaded');
    });

    $('#vectors_google_model').val(settings.google_model).on('input', () => {
        settings.google_model = String($('#vectors_google_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#api_key_nomicai').toggleClass('success', !!secret_state[SECRET_KEYS.NOMICAI]);
    [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
        eventSource.on(event, (/** @type {string} */ key) => {
            if (key !== SECRET_KEYS.NOMICAI) return;
            $('#api_key_nomicai').toggleClass('success', !!secret_state[SECRET_KEYS.NOMICAI]);
        });
    });

    toggleSettings();
    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    eventSource.on(event_types.CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.GROUP_CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.FILE_ATTACHMENT_DELETED, purgeFileVectorIndex);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            await loadWebLlmModels();
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-ingest',
        callback: async () => {
            await ingestDataBankAttachments();
            return '';
        },
        aliases: ['databank-ingest', 'data-bank-ingest'],
        helpString: 'Force the ingestion of all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-purge',
        callback: async () => {
            const dataBank = getDataBankAttachments();

            for (const file of dataBank) {
                await purgeFileVectorIndex(file.url);
            }

            return '';
        },
        aliases: ['databank-purge', 'data-bank-purge'],
        helpString: 'Purge the vector index for all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-search',
        callback: async (args, query) => {
            const validateCount = (v) => Number.isNaN(v) || !Number.isInteger(v) || v < 1 ? null : v;
            const count = validateCount(Number(args?.count)) ?? settings.chunk_count_db;
            const threshold = Number(args?.threshold ?? settings.score_threshold);
            const source = String(args?.source ?? '');
            const attachments = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
            const collectionIds = await ingestDataBankAttachments(String(source));

            // Use smart search for each collection individually
            const queryResults = {};
            for (const collectionId of collectionIds) {
                const searchType = settings.augment_keyword_search ? 'enhanced' : 'basic';
                console.debug(`[Vectors] Slash command querying collection ${collectionId} with ${searchType} search`);
                const collectionResults = await smartQueryCollection(collectionId, String(query), count, threshold);
                queryResults[collectionId] = collectionResults;
            }

            // Get URLs
            const urls = Object
                .keys(queryResults)
                .map(x => attachments.find(y => getFileCollectionId(y.url) === x))
                .filter(x => x)
                .map(x => x.url);

            // Gets the actual text content of chunks
            const getChunksText = () => {
                let textResult = '';
                for (const collectionId in queryResults) {
                    // Get the original metadata objects and extract text
                    const originalMetadata = queryResults[collectionId].metadata?.filter(x => x.text) || [];
                    const sortedMetadata = originalMetadata
                        .sort((a, b) => a.index - b.index)
                        .filter((item, index, arr) => arr.findIndex(x => x.text === item.text) === index);
                    const metadata = sortedMetadata.map(x => x.text);
                    textResult += metadata.join('\n') + '\n\n';
                }
                return textResult;
            };
            if (args.return === 'chunks') {
                return getChunksText();
            }

            // @ts-ignore
            return slashCommandReturnHelper.doReturn(args.return ?? 'object', urls, { objectToStringFunc: list => list.join('\n') });
        },
        aliases: ['databank-search', 'data-bank-search'],
        helpString: 'Search the Data Bank for a specific query using vector similarity. Returns a list of file URLs with the most relevant content.',
        namedArgumentList: [
            new SlashCommandNamedArgument('threshold', 'Threshold for the similarity score in the [0, 1] range. Uses the global config value if not set.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('count', 'Maximum number of query results to return.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('source', 'Optional filter for the attachments by source.', ARGUMENT_TYPE.STRING, false, false, '', ['global', 'character', 'chat']),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'How you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'object',
                enumList: [
                    new SlashCommandEnumValue('chunks', 'Return the actual content chunks', enumTypes.enum, '{}'),
                    ...slashCommandReturnHelper.enumList({ allowObject: true }),
                ],
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('Query to search by.', ARGUMENT_TYPE.STRING, true, false),
        ],
        returns: ARGUMENT_TYPE.LIST,
    }));

    registerDebugFunction('purge-everything', 'Purge all vector indices', 'Obliterate all stored vectors for all sources. No mercy.', async () => {
        if (!confirm('Are you sure?')) {
            return;
        }
        await purgeAllVectorIndexes();
    });
});
