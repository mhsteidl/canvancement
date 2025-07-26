// ==UserScript==
// @name         IntraGroup Peer Reviews
// @namespace    https://github.com/yourname/canvas-peer-review
// @version      4
// @description  Assign peer reviews within groups on Canvas using the same endpoint as the web UI. Works even if students haven't submitted yet.
// @match        https://*.instructure.com/courses/*/assignments/*/peer_reviews
// @grant        none
// @author       @mhsteidl
// ==/UserScript==

// @thanks       Massive thanks to James Jones (@jamesjonesmath) for creating the original version of this script.
//               His work laid the foundation for making Canvas peer review assignments more flexible and powerful.
//               This version builds upon his contributions with deep appreciation and respect for the original.


(function () {
    'use strict';

    // Extract course and assignment ID from the URL
    const [ , courseId, assignmentId ] = window.location.pathname.match(/\/courses\/(\d+)\/assignments\/(\d+)\/peer_reviews/) || [];
    if (!courseId || !assignmentId) return; // Exit if not on a matching page

    // Attempt to read the CSRF token from cookies
    const csrfToken = document.cookie.match(/_csrf_token=([^;]+)/)?.[1];
    if (!csrfToken) {
        alert("CSRF token not found. Please make sure you're logged into Canvas.");
        return;
    }

    /**
     * Fetches and parses a JSON response from the Canvas API.
     * Uses same-origin credentials and handles non-OK responses.
     */
    const fetchJSON = async (url) => {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        });
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.json();
    };

    /**
     * Sends a peer review assignment request using Canvas's internal endpoint.
     * This mimics the web UI and works even if the reviewee hasn't submitted.
     * Parameters:
     * - revieweeId: the user who will be reviewed
     * - assessorId: the user who will perform the review
     */
    const postPeerReview = async (revieweeId, assessorId) => {
        const url = `/courses/${courseId}/assignments/${assignmentId}/peer_reviews/users/${assessorId}`;

        // Get a fresh CSRF token from meta or hidden input field
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ||
              document.querySelector('input[name="authenticity_token"]')?.value;

        // Canvas expects URL-encoded form data, not JSON
        const formBody = new URLSearchParams({
            utf8: '✓',
            authenticity_token: csrfToken,
            reviewee_id: revieweeId,
            _method: 'post'
        });

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            credentials: 'same-origin',
            body: formBody.toString()
        });

        // Log result to console for debugging
        if (!res.ok) {
            const errorText = await res.text();
            console.error(`❌ Failed: reviewer ${assessorId} → reviewee ${revieweeId}`, errorText);
        } else {
            console.log(`✅ Assigned: reviewer ${assessorId} → reviewee ${revieweeId}`);
        }
    };

    /**
     * Builds and injects the sidebar UI that allows users to select a group set
     * and trigger intra-group peer review assignment.
     */
    const createUI = async () => {
        const sidebar = document.querySelector('#right-side-wrapper aside#right-side');
        if (!sidebar || document.getElementById('peer-review-tool')) return; // Avoid duplicate UI

        const container = document.createElement('div');
        container.id = 'peer-review-tool';
        container.classList.add('ic-teacher-sidebar-module');
        container.innerHTML = `
            <h3>Intra-Group Reviews</h3>
            <p>Assign all-to-all reviews within each group.</p>
            <select id="group-set-select" style="width: 100%; margin-bottom: 8px;"></select>
            <button class="btn" id="assign-reviews-btn">Assign Reviews</button>
            <progress id="intragroup_progress" style="width: 90%; display: none; height: 2em;"></progress>
            <div id="peer-review-log" style="margin-top: 8px; font-size: 0.9em;"></div>
        `;
        sidebar.appendChild(container);

        const groupSets = await fetchJSON(`/api/v1/courses/${courseId}/group_categories?per_page=100`);
        const select = document.getElementById('group-set-select');

        if (groupSets.length === 1) {
            // Auto-select the only group set if there is just one
            const onlySet = groupSets[0];
            select.add(new Option(onlySet.name, onlySet.id, true, true));
        } else {
            // For multiple sets, add a default option and list all
            select.add(new Option('Choose a group set', ''));
            groupSets.forEach(set => {
                select.add(new Option(set.name, set.id));
            });
        }

        // Set up button click to trigger peer review assignment
        document.getElementById('assign-reviews-btn').addEventListener('click', async () => {
            const selectedGroupSetId = select.value;
            if (!selectedGroupSetId) {
                alert('Please select a group set.');
                return;
            }
            await assignIntragroupReviews(selectedGroupSetId);
        });
    };

    /**
     * Updates the progress bar based on a completion ratio.
     * @param {number|undefined} x - A number from 0 to 1 (progress), or undefined for indeterminate
     */
    function updateProgressBar(x) {
        const progress = document.getElementById('intragroup_progress');
        if (!progress) return;

        if (typeof x === 'undefined') { // Indeterminate state
            progress.removeAttribute('value');
            progress.style.display = 'inline-block';
        } else if (x >= 0 && x < 1) { // Show progress
            progress.value = x;
            progress.textContent = `${Math.round(x * 100)}%`;
            progress.style.display = 'inline-block';
        } else { // Hide when done
            progress.style.display = 'none';
        }
    }

    /**
     * Main function that:
     * - Fetches groups and members
     * - Checks for existing peer reviews
     * - Assigns all-to-all reviews within each group
     * - Displays progress and logs completion
     * @param {string} groupSetId - ID of the selected group set
     */
    const assignIntragroupReviews = async (groupSetId) => {
        const log = document.getElementById('peer-review-log');
        log.textContent = 'Fetching group data...';

        const groups = await fetchJSON(`/api/v1/group_categories/${groupSetId}/groups?per_page=100`);
        const peerReviews = await fetchJSON(`/api/v1/courses/${courseId}/assignments/${assignmentId}/peer_reviews?per_page=100`);

        // Build a Set of already-assigned reviews
        const existing = new Set(peerReviews.map(r => `${r.assessor_id}:${r.user_id}`));
        const assignments = [];

        // Create a list of new reviewer-reviewee pairs to assign
        for (const group of groups) {
            const members = await fetchJSON(`/api/v1/groups/${group.id}/users?per_page=100`);
            const ids = members.map(u => u.id);

            for (const assessor of ids) {
                for (const reviewee of ids) {
                    if (assessor === reviewee) continue; // Skip self-review
                    const key = `${assessor}:${reviewee}`;
                    if (!existing.has(key)) {
                        assignments.push([reviewee, assessor]);
                    }
                }
            }
        }

        const total = assignments.length;
        if (total === 0) {
            log.textContent = '✅ No new peer reviews needed. All already assigned.';
            updateProgressBar(1);
            return;
        }

        log.textContent = `Assigning ${total} peer reviews...`;
        updateProgressBar(0);

        let completed = 0;
        const concurrency = 20; // Max number of simultaneous review POSTs

        // Function to update the progress bar and UI after each assignment
        const updateProgress = () => {
            completed++;
            updateProgressBar(completed / total);
            log.textContent = `Assigned ${completed} of ${total} reviews...`;
        };

        /**
         * Executes a batch of peer review assignments in parallel.
         * Uses Promise.allSettled to ensure all results are handled.
         */
        const executeBatch = async (batch) => {
            await Promise.allSettled(
                batch.map(([reviewee, assessor]) =>
                    postPeerReview(reviewee, assessor).finally(updateProgress)
                )
            );
        };

        // Run assignments in batches to avoid overloading Canvas API
        for (let i = 0; i < assignments.length; i += concurrency) {
            const batch = assignments.slice(i, i + concurrency);
            await executeBatch(batch);
        }

        updateProgressBar(1);
        log.textContent = `✅ Done. ${total} reviews assigned. Reload the page to verify.`;
    };

    // Automatically create the sidebar UI when the page loads
    createUI();
})();
