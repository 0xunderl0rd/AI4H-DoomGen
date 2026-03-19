//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//	Archiving: SaveGame I/O.
//	Thinker, Ticker.
//


#include "z_zone.h"
#include "p_local.h"

#include "doomstat.h"


int	leveltime;

//
// THINKERS
// All thinkers should be allocated by Z_Malloc
// so they can be operated on uniformly.
// The actual structures will vary in size,
// but the first element must be thinker_t.
//



// Both the head and tail of the thinker list.
thinker_t	thinkercap;


//
// P_InitThinkers
//
void P_InitThinkers (void)
{
    thinkercap.prev = thinkercap.next  = &thinkercap;
}




//
// P_AddThinker
// Adds a new thinker at the end of the list.
//
void P_AddThinker (thinker_t* thinker)
{
    thinkercap.prev->next = thinker;
    thinker->next = &thinkercap;
    thinker->prev = thinkercap.prev;
    thinkercap.prev = thinker;
}



//
// P_RemoveThinker
// Deallocation is lazy -- it will not actually be freed
// until its thinking turn comes up.
//
void P_RemoveThinker (thinker_t* thinker)
{
  // FIXME: NOP.
  thinker->function.acv = (actionf_v)(-1);
}



//
// P_AllocateThinker
// Allocates memory and adds a new thinker at the end of the list.
//
void P_AllocateThinker (thinker_t*	thinker)
{
}



//
// P_RunThinkers
//
void P_RunThinkers (void)
{
    thinker_t *currentthinker, *nextthinker;
#ifdef __EMSCRIPTEN__
    static int emscripten_runthinkers_logs = 0;
    int emscripten_thinker_steps = 0;
#endif

    currentthinker = thinkercap.next;
    while (currentthinker != &thinkercap)
    {
#ifdef __EMSCRIPTEN__
        if (emscripten_runthinkers_logs < 0)
        {
            printf("P_RunThinkers: step=%d thinker=%p fn=%p\n",
                   emscripten_thinker_steps, (void *) currentthinker, (void *) currentthinker->function.acv);
        }
#endif
	if ( currentthinker->function.acv == (actionf_v)(-1) )
	{
	    // time to remove it
            nextthinker = currentthinker->next;
	    currentthinker->next->prev = currentthinker->prev;
	    currentthinker->prev->next = currentthinker->next;
	    Z_Free(currentthinker);
	}
	else
	{
	    if (currentthinker->function.acp1)
            {
#ifdef __EMSCRIPTEN__
                if (emscripten_runthinkers_logs < 0)
                {
                    printf("P_RunThinkers: before thinker call step=%d thinker=%p fn=%p\n",
                           emscripten_thinker_steps, (void *) currentthinker, (void *) currentthinker->function.acv);
                }
#endif
		currentthinker->function.acp1 (currentthinker);
#ifdef __EMSCRIPTEN__
                if (emscripten_runthinkers_logs < 0)
                {
                    printf("P_RunThinkers: after thinker call step=%d thinker=%p\n",
                           emscripten_thinker_steps, (void *) currentthinker);
                }
#endif
            }
            nextthinker = currentthinker->next;
	}
	currentthinker = nextthinker;
#ifdef __EMSCRIPTEN__
        ++emscripten_thinker_steps;
        if (emscripten_thinker_steps > 200000)
        {
            printf("P_RunThinkers: emergency break after %d steps\n", emscripten_thinker_steps);
            break;
        }
#endif
    }
#ifdef __EMSCRIPTEN__
    if (emscripten_runthinkers_logs < 0)
    {
        printf("P_RunThinkers: completed steps=%d\n", emscripten_thinker_steps);
        ++emscripten_runthinkers_logs;
    }
#endif
}



//
// P_Ticker
//

void P_Ticker (void)
{
    int		i;
#ifdef __EMSCRIPTEN__
    static int emscripten_pticker_logs = 0;
#endif
    
#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: entry paused=%d menuactive=%d demoplayback=%d netgame=%d viewz=%d leveltime=%d\n",
               paused, menuactive, demoplayback, netgame, players[consoleplayer].viewz, leveltime);
    }
#endif

    // run the tic
    if (paused)
    {
#ifdef __EMSCRIPTEN__
        if (emscripten_pticker_logs < 0)
        {
            printf("P_Ticker: early return paused leveltime=%d\n", leveltime);
            ++emscripten_pticker_logs;
        }
#endif
	return;
    }
		
    // pause if in menu and at least one tic has been run
    if ( !netgame
	 && menuactive
	 && !demoplayback
	 && players[consoleplayer].viewz != 1)
    {
#ifdef __EMSCRIPTEN__
        if (emscripten_pticker_logs < 0)
        {
            printf("P_Ticker: early return menu gate leveltime=%d\n", leveltime);
            ++emscripten_pticker_logs;
        }
#endif
	return;
    }

#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: before player loop leveltime=%d\n", leveltime);
    }
#endif
    
		
    for (i=0 ; i<MAXPLAYERS ; i++)
	if (playeringame[i])
        {
#ifdef __EMSCRIPTEN__
            if (emscripten_pticker_logs < 0)
            {
                printf("P_Ticker: before P_PlayerThink player=%d leveltime=%d\n", i, leveltime);
            }
#endif
	    P_PlayerThink (&players[i]);
#ifdef __EMSCRIPTEN__
            if (emscripten_pticker_logs < 0)
            {
                printf("P_Ticker: after P_PlayerThink player=%d leveltime=%d\n", i, leveltime);
            }
#endif
        }

#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: before P_RunThinkers leveltime=%d\n", leveltime);
    }
#endif
    P_RunThinkers ();
#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: after P_RunThinkers leveltime=%d\n", leveltime);
        printf("P_Ticker: before P_UpdateSpecials leveltime=%d\n", leveltime);
    }
#endif
    P_UpdateSpecials ();
#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: after P_UpdateSpecials leveltime=%d\n", leveltime);
        printf("P_Ticker: before P_RespawnSpecials leveltime=%d\n", leveltime);
    }
#endif
    P_RespawnSpecials ();
#ifdef __EMSCRIPTEN__
    if (emscripten_pticker_logs < 0)
    {
        printf("P_Ticker: after P_RespawnSpecials leveltime=%d\n", leveltime);
        ++emscripten_pticker_logs;
    }
#endif

    // for par times
    leveltime++;	
}
